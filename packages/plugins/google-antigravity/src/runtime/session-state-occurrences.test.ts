import { expect, test } from "bun:test";
import type { ReplayPart } from "../protocol/replay-cache";
import { prepareReasoningReplay } from "./session-state";
import { orderedReplayParts } from "./session-state/prepare/replay-parts";

const MODEL = "claude-opus-4-6-thinking";
const FIRST_SIGNATURE = "first-occurrence-signature-".repeat(3);
const SECOND_SIGNATURE = "second-occurrence-signature-".repeat(3);
const EXISTING_SIGNATURE = "existing-valid-signature-".repeat(3);
const OTHER_SIGNATURE = "other-valid-signature-".repeat(3);
const CALL = { name: "weather", args: { city: "Paris" } };

test.each([
  {
    label: "one content",
    replay: [replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)],
  },
  {
    label: "multiple contents",
    replay: [replayCall(0, 3, FIRST_SIGNATURE), replayCall(1, 0, SECOND_SIGNATURE)],
  },
])("retains identical no-ID replay occurrences across $label", ({ replay }) => {
  expect(preparedParts(replay)).toEqual([signedCall(FIRST_SIGNATURE), signedCall(SECOND_SIGNATURE)]);
});

test("assigns two existing no-ID call slots to two replay occurrences", () => {
  const existing = [
    { functionCall: CALL, providerMetadata: { occurrence: "first" } },
    { functionCall: CALL, providerMetadata: { occurrence: "second" } },
  ];

  expect(preparedParts([replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)], existing)).toEqual([
    { ...existing[0], thoughtSignature: FIRST_SIGNATURE },
    { ...existing[1], thoughtSignature: SECOND_SIGNATURE },
  ]);
});

test("inserts a missing no-ID occurrence after assigning the available existing slot", () => {
  const existing = [{ functionCall: CALL, providerMetadata: { occurrence: "first" } }];

  expect(preparedParts([replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)], existing)).toEqual([
    { ...existing[0], thoughtSignature: FIRST_SIGNATURE },
    signedCall(SECOND_SIGNATURE),
  ]);
});

test.each([
  {
    label: "one expected and two existing retransmissions",
    replay: [replayCall(0, 0, FIRST_SIGNATURE)],
    existing: [
      { functionCall: CALL, thoughtSignature: "short", providerMetadata: { occurrence: "invalid" } },
      { functionCall: CALL, thoughtSignature: EXISTING_SIGNATURE, providerMetadata: { occurrence: "valid" } },
    ],
    expected: [{ functionCall: CALL, thoughtSignature: FIRST_SIGNATURE, providerMetadata: { occurrence: "valid" } }],
  },
  {
    label: "two expected and three existing retransmissions",
    replay: [replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)],
    existing: [
      { functionCall: CALL, thoughtSignature: "short", providerMetadata: { occurrence: "invalid" } },
      { text: "fixed text slot" },
      { functionCall: CALL, providerMetadata: { occurrence: "unsigned" } },
      { functionCall: CALL, thoughtSignature: EXISTING_SIGNATURE, providerMetadata: { occurrence: "valid" } },
    ],
    expected: [
      { functionCall: CALL, thoughtSignature: FIRST_SIGNATURE, providerMetadata: { occurrence: "valid" } },
      { text: "fixed text slot" },
      { functionCall: CALL, thoughtSignature: SECOND_SIGNATURE, providerMetadata: { occurrence: "unsigned" } },
    ],
  },
])("deduplicates only provable extras for $label", ({ replay, existing, expected }) => {
  expect(preparedParts(replay, existing)).toEqual(expected);
});

test("reserves an exact signed candidate for its cached identical-call occurrence", () => {
  const existing = [
    { functionCall: CALL, thoughtSignature: SECOND_SIGNATURE, providerMetadata: { occurrence: "second" } },
  ];

  expect(preparedParts([replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)], existing)).toEqual([
    signedCall(FIRST_SIGNATURE),
    existing[0],
  ]);
});

test("restores cached identical-call signature order from reversed existing candidates", () => {
  const existing = [
    { functionCall: CALL, thoughtSignature: SECOND_SIGNATURE, providerMetadata: { occurrence: "second" } },
    { functionCall: CALL, thoughtSignature: FIRST_SIGNATURE, providerMetadata: { occurrence: "first" } },
  ];

  expect(preparedParts([replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)], existing)).toEqual([
    existing[1],
    existing[0],
  ]);
});

test("does not let an earlier occurrence steal a later exact signature match", () => {
  const existing = [
    { functionCall: CALL, thoughtSignature: SECOND_SIGNATURE, providerMetadata: { occurrence: "second" } },
    { functionCall: CALL, thoughtSignature: "short", providerMetadata: { occurrence: "invalid" } },
  ];

  expect(preparedParts([replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)], existing)).toEqual([
    { ...existing[1], thoughtSignature: FIRST_SIGNATURE },
    existing[0],
  ]);
});

test("replaces a wrong valid signature and prefers unsigned over invalid extras", () => {
  const existing = [
    { functionCall: CALL, thoughtSignature: OTHER_SIGNATURE, providerMetadata: { occurrence: "wrong-valid" } },
    { functionCall: CALL, thoughtSignature: "short", providerMetadata: { occurrence: "invalid" } },
    { functionCall: CALL, providerMetadata: { occurrence: "unsigned" } },
  ];

  expect(preparedParts([replayCall(0, 0, FIRST_SIGNATURE), replayCall(0, 1, SECOND_SIGNATURE)], existing)).toEqual([
    { ...existing[0], thoughtSignature: FIRST_SIGNATURE },
    { ...existing[2], thoughtSignature: SECOND_SIGNATURE },
  ]);
});

test("ordered replay deduplicates only the same structural occurrence", () => {
  const sameOccurrenceUnsigned = replayCall(0, 0, undefined);
  const sameOccurrenceSigned = replayCall(0, 0, FIRST_SIGNATURE);
  const distinctOccurrence = replayCall(0, 1, SECOND_SIGNATURE);

  expect(orderedReplayParts([sameOccurrenceUnsigned, sameOccurrenceSigned, distinctOccurrence])).toEqual([
    replayCall(0, 0, FIRST_SIGNATURE),
    distinctOccurrence,
  ]);
});

function preparedParts(
  replay: readonly ReplayPart[],
  existing?: readonly Record<string, unknown>[],
): readonly unknown[] {
  const responses = replay
    .filter((part) => part.type === "function-call")
    .map(() => ({ functionResponse: { name: "weather", response: { ok: true } } }));
  const response = { role: "user", parts: responses };
  const contents =
    existing === undefined
      ? [{ role: "user", parts: [{ text: "use weather twice" }] }, response]
      : [{ role: "model", parts: existing }, response];
  const prepared = prepareReasoningReplay({ contents }, MODEL, { parts: replay });
  const modelIndex = existing === undefined ? 1 : 0;
  return (prepared.contents[modelIndex] as { readonly parts: readonly unknown[] }).parts;
}

function replayCall(contentIndex: number, partIndex: number, signature: string | undefined): ReplayPart {
  return {
    type: "function-call",
    contentIndex,
    partIndex,
    call: CALL,
    ...(signature === undefined ? {} : { signature }),
  };
}

function signedCall(signature: string) {
  return { functionCall: CALL, thoughtSignature: signature };
}

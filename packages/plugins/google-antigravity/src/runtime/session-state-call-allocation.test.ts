import { expect, test } from "bun:test";

import type { ReplayPart } from "../protocol/replay-cache";

import { prepareReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const FIRST_SIGNATURE = "first-allocation-signature-".repeat(3);
const SECOND_SIGNATURE = "second-allocation-signature-".repeat(3);
const THIRD_SIGNATURE = "third-allocation-signature-".repeat(3);
const OTHER_SIGNATURE = "other-allocation-signature-".repeat(3);

test.each([
  {
    label: "maximizes matches before committing an ID-less replay occurrence",
    existing: [candidate(undefined, "wildcard"), candidate("B", "B")],
    replay: [replayCall(undefined, FIRST_SIGNATURE, 0), replayCall("A", SECOND_SIGNATURE, 1)],
    responseId: "A",
    expected: [signedCandidate("B", "B", FIRST_SIGNATURE), signedCandidate(undefined, "wildcard", SECOND_SIGNATURE)],
  },
  {
    label: "allocates multiple explicit IDs before the remaining wildcard",
    existing: [candidate(undefined, "wildcard"), candidate("B", "B"), candidate("C", "C")],
    replay: [
      replayCall(undefined, FIRST_SIGNATURE, 0),
      replayCall("A", SECOND_SIGNATURE, 1),
      replayCall("B", THIRD_SIGNATURE, 2),
    ],
    responseId: "B",
    expected: [
      signedCandidate("C", "C", FIRST_SIGNATURE),
      signedCandidate(undefined, "wildcard", SECOND_SIGNATURE),
      signedCandidate("B", "B", THIRD_SIGNATURE),
    ],
  },
  {
    label: "uses an exact replay signature when existing candidates are fewer",
    existing: [candidate(undefined, "only", SECOND_SIGNATURE)],
    replay: [replayCall("A", FIRST_SIGNATURE, 0), replayCall("B", SECOND_SIGNATURE, 1)],
    responseId: "B",
    expected: [insertedCall("A", FIRST_SIGNATURE), candidate(undefined, "only", SECOND_SIGNATURE)],
  },
  {
    label: "retains the valid candidate when existing candidates are more numerous",
    existing: [
      candidate(undefined, "invalid", "short"),
      candidate(undefined, "unsigned"),
      candidate(undefined, "valid", OTHER_SIGNATURE),
    ],
    replay: [replayCall(undefined, undefined, 0)],
    responseId: undefined,
    expected: [candidate(undefined, "valid", OTHER_SIGNATURE)],
  },
  {
    label: "prefers exact IDs over crossed exact replay signatures",
    existing: [candidate("A", "A", SECOND_SIGNATURE), candidate(undefined, "wildcard", FIRST_SIGNATURE)],
    replay: [replayCall("A", FIRST_SIGNATURE, 0), replayCall(undefined, SECOND_SIGNATURE, 1)],
    responseId: "A",
    expected: [signedCandidate("A", "A", FIRST_SIGNATURE), signedCandidate(undefined, "wildcard", SECOND_SIGNATURE)],
  },
  {
    label: "restores exact IDs from reversed physical slots",
    existing: [candidate("B", "B"), candidate("A", "A")],
    replay: [replayCall("A", FIRST_SIGNATURE, 0), replayCall("B", SECOND_SIGNATURE, 1)],
    responseId: "A",
    expected: [signedCandidate("A", "A", FIRST_SIGNATURE), signedCandidate("B", "B", SECOND_SIGNATURE)],
  },
  {
    label: "keeps physical candidate order when all higher priorities tie",
    existing: [candidate(undefined, "first"), candidate(undefined, "second")],
    replay: [replayCall(undefined, FIRST_SIGNATURE, 0), replayCall(undefined, SECOND_SIGNATURE, 1)],
    responseId: undefined,
    expected: [
      signedCandidate(undefined, "first", FIRST_SIGNATURE),
      signedCandidate(undefined, "second", SECOND_SIGNATURE),
    ],
  },
])("$label", ({ existing, expected, replay, responseId }) => {
  expect(preparedParts(existing, replay, responseId)).toEqual(expected);
});

test("keeps structurally distinct calls separate when their old delimiter keys collide", () => {
  const firstCall = { name: "weather", args: ["a,string:b"] };
  const secondCall = { name: "weather", args: ["a", "b"] };
  const existing = [
    { functionCall: secondCall, providerMetadata: { retained: "second" } },
    { functionCall: firstCall, providerMetadata: { retained: "first" } },
  ];
  const replay: ReplayPart[] = [
    { type: "function-call", contentIndex: 0, partIndex: 0, call: firstCall, signature: FIRST_SIGNATURE },
    { type: "function-call", contentIndex: 0, partIndex: 1, call: secondCall, signature: SECOND_SIGNATURE },
  ];

  expect(preparedParts(existing, replay, undefined)).toEqual([
    { ...existing[1], thoughtSignature: FIRST_SIGNATURE },
    { ...existing[0], thoughtSignature: SECOND_SIGNATURE },
  ]);
});

function preparedParts(
  existing: readonly Record<string, unknown>[],
  replay: readonly ReplayPart[],
  responseId: string | undefined,
): readonly unknown[] {
  const response = {
    role: "user",
    parts: [
      {
        functionResponse: {
          ...(responseId === undefined ? {} : { id: responseId }),
          name: "weather",
          response: { ok: true },
        },
      },
    ],
  };
  const prepared = prepareReasoningReplay({ contents: [{ role: "model", parts: existing }, response] }, MODEL, {
    parts: replay,
  });
  return (prepared.contents[0] as { readonly parts: readonly unknown[] }).parts;
}

function candidate(id: string | undefined, retained: string, thoughtSignature?: string) {
  return {
    functionCall: call(id),
    ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    providerMetadata: { retained },
  };
}

function signedCandidate(id: string | undefined, retained: string, thoughtSignature: string) {
  return { ...candidate(id, retained), thoughtSignature };
}

function insertedCall(id: string, thoughtSignature: string) {
  return { functionCall: call(id), thoughtSignature };
}

function replayCall(id: string | undefined, signature: string | undefined, partIndex: number): ReplayPart {
  return {
    type: "function-call",
    contentIndex: 0,
    partIndex,
    call: call(id),
    ...(signature === undefined ? {} : { signature }),
  };
}

function call(id: string | undefined) {
  return { ...(id === undefined ? {} : { id }), name: "weather", args: { city: "Paris" } };
}

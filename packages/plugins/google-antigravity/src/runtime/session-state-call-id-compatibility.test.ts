import { expect, test } from "bun:test";

import type { ReplayPart } from "../protocol/replay-cache";

import { prepareReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "canonical-call-signature-".repeat(3);
const SECOND_SIGNATURE = "second-call-signature-".repeat(4);
const OTHER_SIGNATURE = "other-valid-signature-".repeat(4);

test.each([
  { cachedId: "same", existingId: "same", label: "equal IDs", matches: true },
  { cachedId: "cached", existingId: "existing", label: "different IDs", matches: false },
  { cachedId: "cached", existingId: undefined, label: "missing existing ID", matches: true },
  { cachedId: undefined, existingId: "generated", label: "missing cached ID", matches: true },
])("uses canonical fields for $label", ({ cachedId, existingId, matches }) => {
  const cached = callWithId(cachedId);
  const existing = { functionCall: callWithId(existingId), providerMetadata: { retained: true } };
  const responseId = cachedId ?? existingId;
  const body = {
    contents: [
      { role: "model", parts: [existing] },
      {
        role: "user",
        parts: [{ functionResponse: { ...(responseId === undefined ? {} : { id: responseId }), name: "weather" } }],
      },
    ],
  };
  const prepared = prepareReasoningReplay(body, MODEL, { parts: [replayCall(cached, SIGNATURE)] });

  if (matches) {
    expect(prepared.contents).toEqual([
      { role: "model", parts: [{ ...existing, thoughtSignature: SIGNATURE }] },
      body.contents[1],
    ]);
  } else {
    expect(prepared.contents).toEqual(body.contents);
  }
});

test("preserves generated IDs across repeated compatible occurrences", () => {
  const existing = [
    { functionCall: callWithId("generated-0"), providerMetadata: { occurrence: 0 } },
    { functionCall: callWithId("generated-1"), providerMetadata: { occurrence: 1 } },
  ];
  const replay = [
    replayCall(callWithId(undefined), SIGNATURE, 0),
    replayCall(callWithId(undefined), SECOND_SIGNATURE, 1),
  ];

  expect(preparedParts(existing, replay)).toEqual([
    { ...existing[0], thoughtSignature: SIGNATURE },
    { ...existing[1], thoughtSignature: SECOND_SIGNATURE },
  ]);
});

test("does not equate parsed null args with a no-args call", () => {
  const cached = { name: "weather", args: null };
  const existing = { functionCall: { id: "generated", name: "weather", args: {} } };
  const response = {
    role: "user",
    parts: [{ functionResponse: { id: "generated", name: "weather", response: {} } }],
  };
  const body = { contents: [{ role: "model", parts: [existing] }, response] };

  expect(prepareReasoningReplay(body, MODEL, { parts: [replayCall(cached, SIGNATURE)] }).contents).toEqual(
    body.contents,
  );
});

test("assigns an ID-less slot without stealing a distinct exact-ID occurrence", () => {
  const first = { functionCall: callWithId(undefined), providerMetadata: { occurrence: "compatible" } };
  const second = {
    functionCall: callWithId("call-b"),
    thoughtSignature: SECOND_SIGNATURE,
    providerMetadata: { occurrence: "exact" },
  };
  const replay = [
    replayCall(callWithId("call-a"), SIGNATURE, 0),
    replayCall(callWithId("call-b"), SECOND_SIGNATURE, 1),
  ];

  expect(preparedParts([first, second], replay, "call-b")).toEqual([{ ...first, thoughtSignature: SIGNATURE }, second]);
});

test("reserves the exact cached signature among generated-ID candidates", () => {
  const existing = [
    {
      functionCall: callWithId("generated-wrong"),
      thoughtSignature: OTHER_SIGNATURE,
      providerMetadata: { retained: "wrong" },
    },
    {
      functionCall: callWithId("generated-exact"),
      thoughtSignature: SIGNATURE,
      providerMetadata: { retained: "exact" },
    },
  ];

  expect(preparedParts(existing, [replayCall(callWithId(undefined), SIGNATURE)], "generated-exact")).toEqual([
    existing[1],
  ]);
});

function preparedParts(
  existing: readonly unknown[],
  replay: readonly ReplayPart[],
  responseId = "generated-0",
): readonly unknown[] {
  const body = {
    contents: [
      { role: "model", parts: existing },
      { role: "user", parts: [{ functionResponse: { id: responseId, name: "weather", response: {} } }] },
    ],
  };
  const prepared = prepareReasoningReplay(body, MODEL, { parts: replay });
  return (prepared.contents[0] as { readonly parts: readonly unknown[] }).parts;
}

function callWithId(id: string | undefined) {
  return { ...(id === undefined ? {} : { id }), name: "weather", args: { city: "Paris" } };
}

function replayCall(call: unknown, signature: string, partIndex = 0): ReplayPart {
  return { type: "function-call", contentIndex: 0, partIndex, call, signature };
}

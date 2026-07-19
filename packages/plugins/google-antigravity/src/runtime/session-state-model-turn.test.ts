import { expect, test } from "bun:test";

import { prepareReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);

test.each([
  {
    existing: "a",
    parts: [callPart("a"), textPart("after-a")],
    expected: [signedCallPart("a"), textPart("after-a"), signedCallPart("b"), signedCallPart("c")],
  },
  {
    existing: "b",
    parts: [textPart("before-b"), callPart("b"), textPart("after-b")],
    expected: [
      textPart("before-b"),
      signedCallPart("a"),
      signedCallPart("b"),
      textPart("after-b"),
      signedCallPart("c"),
    ],
  },
  {
    existing: "c",
    parts: [textPart("before-c"), callPart("c")],
    expected: [textPart("before-c"), signedCallPart("a"), signedCallPart("b"), signedCallPart("c")],
  },
])("preserves unmatched transcript parts when the existing cached call is $existing", ({ parts, expected }) => {
  expect(preparedParts(parts, ["a", "b", "c"])).toEqual(expected);
});

test("signs A and B in place without moving text between them", () => {
  const text = textPart("between-calls");

  expect(preparedParts([callPart("a"), text, callPart("b")], ["a", "b"])).toEqual([
    signedCallPart("a"),
    text,
    signedCallPart("b"),
  ]);
});

test("inserts missing B after unrelated text without moving the text", () => {
  const text = textPart("after-a");

  expect(preparedParts([callPart("a"), text], ["a", "b"])).toEqual([signedCallPart("a"), text, signedCallPart("b")]);
});

test.each([
  {
    label: "missing middle call",
    parts: [callPart("c"), textPart("fixed-slot"), callPart("a")],
    expected: [signedCallPart("a"), textPart("fixed-slot"), signedCallPart("b"), signedCallPart("c")],
  },
  {
    label: "all calls present",
    parts: [callPart("c"), textPart("fixed-slot"), callPart("a"), callPart("b")],
    expected: [signedCallPart("a"), textPart("fixed-slot"), signedCallPart("b"), signedCallPart("c")],
  },
])("orders out-of-order existing call anchors with $label", ({ parts, expected }) => {
  expect(preparedParts(parts, ["a", "b", "c"])).toEqual(expected);
});

test("deduplicates a retransmitted cached function-call occurrence while enriching an existing turn", () => {
  const a = toolCall("a");
  const b = toolCall("b");
  const body = {
    contents: [
      { role: "model", parts: [{ functionCall: b }] },
      { role: "user", parts: [{ functionResponse: { id: b.id, name: b.name, response: {} } }] },
    ],
  };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [
      { type: "function-call", contentIndex: 0, partIndex: 0, call: a, signature: SIGNATURE },
      { type: "function-call", contentIndex: 0, partIndex: 0, call: a, signature: SIGNATURE },
      { type: "function-call", contentIndex: 0, partIndex: 1, call: b, signature: SIGNATURE },
    ],
  });
  const model = prepared.contents[0] as { readonly parts: readonly Record<string, unknown>[] };

  expect(model.parts.map((part) => (part.functionCall as { id: string }).id)).toEqual(["a", "b"]);
});

function preparedParts(parts: readonly unknown[], replayIds: readonly string[]): readonly unknown[] {
  const calls = replayIds.map(toolCall);
  const body = {
    contents: [
      { role: "model", parts },
      {
        role: "user",
        parts: calls.map((call) => ({ functionResponse: { id: call.id, name: call.name, response: {} } })),
      },
    ],
  };
  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: calls.map((call, partIndex) => ({
      type: "function-call" as const,
      contentIndex: 0,
      partIndex,
      call,
      signature: SIGNATURE,
    })),
  });
  return (prepared.contents[0] as { readonly parts: readonly unknown[] }).parts;
}

function toolCall(id: string) {
  return { id, name: `tool-${id}`, args: { id } };
}

function callPart(id: string) {
  return { functionCall: toolCall(id) };
}

function signedCallPart(id: string) {
  return { functionCall: toolCall(id), thoughtSignature: SIGNATURE };
}

function textPart(text: string) {
  return { text };
}

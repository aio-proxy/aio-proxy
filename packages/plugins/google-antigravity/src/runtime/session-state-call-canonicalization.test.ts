import { expect, test } from "bun:test";
import { capturedReplay, codecCalls, TEST_MODEL as MODEL } from "../../test-support/google-codec-replay";
import type { ReplayPart } from "../protocol/replay-cache";
import { prepareReasoningReplay } from "./session-state";

const SIGNATURE = "canonical-call-signature-".repeat(3);

test.each([
  {
    label: "object",
    rawArgs: '{"city":"Paris","days":[1,{"unit":"c"}]}',
    expectedArgs: { city: "Paris", days: [1, { unit: "c" }] },
  },
  {
    label: "nested array",
    rawArgs: '[{"city":"Paris"},["nested",2]]',
    expectedArgs: [{ city: "Paris" }, ["nested", 2]],
  },
  { label: "number primitive", rawArgs: "42", expectedArgs: 42 },
  { label: "boolean primitive", rawArgs: "true", expectedArgs: true },
  { label: "string primitive", rawArgs: '"true"', expectedArgs: "true" },
  { label: "null primitive", rawArgs: "null", expectedArgs: null },
  { label: "invalid string", rawArgs: "not-json", expectedArgs: "not-json" },
])("captures complete $label args with the Google codec representation", async ({ rawArgs, expectedArgs }) => {
  const events = [completeCallFrame({ args: rawArgs, id: "call-1", name: "weather" })];
  const codecCall = await firstCodecCall(events);

  expect(codecCall.args).toEqual(expectedArgs);
  expect((await capturedReplay(events, `complete-${rawArgs}`))?.parts).toEqual([replayCall(codecCall, SIGNATURE)]);
});

test.each([
  { label: "actual null", call: { args: null, id: "call-1", name: "weather" } },
  { label: "absent", call: { id: "call-1", name: "weather" } },
])("captures $label complete args with the Google codec no-args representation", async ({ call, label }) => {
  const events = [completeCallFrame(call)];
  const codecCall = await firstCodecCall(events);

  expect(codecCall.args).toEqual({});
  expect((await capturedReplay(events, `no-args-${label}`))?.parts).toEqual([replayCall(codecCall, SIGNATURE)]);
});

test.each([
  { label: "object", historyArgs: { city: "Paris" }, replayArgs: { city: "Paris" } },
  { label: "array", historyArgs: ["Paris", 2], replayArgs: ["Paris", 2] },
  { label: "number primitive", historyArgs: 42, replayArgs: 42 },
  { label: "boolean primitive", historyArgs: true, replayArgs: true },
  { label: "null primitive", historyArgs: null, replayArgs: null },
  { label: "string primitive true", historyArgs: "true", replayArgs: "true" },
  { label: "string primitive number", historyArgs: "42", replayArgs: "42" },
  { label: "string primitive null", historyArgs: "null", replayArgs: "null" },
  { label: "invalid JSON string", historyArgs: "not-json", replayArgs: "not-json" },
])("matches existing canonical $label args against the cached canonical representation", ({
  historyArgs,
  label,
  replayArgs,
}) => {
  const existing = {
    functionCall: { id: "call-1", name: "weather", args: historyArgs },
    providerMetadata: { retained: label },
  };
  const response = {
    role: "user",
    parts: [{ functionResponse: { id: "call-1", name: "weather", response: { ok: true } } }],
  };
  const body = { contents: [{ role: "model", parts: [existing] }, response] };

  expect(
    prepareReasoningReplay(body, MODEL, {
      parts: [replayCall({ id: "call-1", name: "weather", args: replayArgs }, SIGNATURE)],
    }).contents,
  ).toEqual([{ role: "model", parts: [{ ...existing, thoughtSignature: SIGNATURE }] }, response]);
});

test.each([
  { canonicalString: "true", differentPrimitive: true, label: "boolean" },
  { canonicalString: "42", differentPrimitive: 42, label: "number" },
  { canonicalString: "null", differentPrimitive: null, label: "null" },
])("does not conflate a canonical string primitive with a $label value", ({ canonicalString, differentPrimitive }) => {
  const existing = { functionCall: { id: "call-1", name: "weather", args: differentPrimitive } };
  const response = {
    role: "user",
    parts: [{ functionResponse: { id: "call-1", name: "weather", response: { ok: true } } }],
  };
  const body = { contents: [{ role: "model", parts: [existing] }, response] };

  expect(
    prepareReasoningReplay(body, MODEL, {
      parts: [replayCall({ id: "call-1", name: "weather", args: canonicalString }, SIGNATURE)],
    }).contents,
  ).toEqual(body.contents);
});

test.each([
  { label: "complete args", events: [completeCallFrame({ args: '{"city":"Paris"}', name: "weather" })] },
  { label: "no args", events: [completeCallFrame({ name: "weather" })] },
  { label: "streamed partialArgs", events: streamedCallFrames() },
])("matches a generated codec ID in place for $label", async ({ events, label }) => {
  const call = await firstCodecCall(events);
  const replay = await capturedReplay(events, `generated-id-${label}`);
  const existing = { functionCall: call, providerMetadata: { retained: label } };
  const response = { functionResponse: { id: call.id, name: call.name, response: { ok: true } } };
  const body = {
    contents: [
      { role: "model", parts: [existing] },
      { role: "user", parts: [response] },
    ],
  };

  expect(prepareReasoningReplay(body, MODEL, replay).contents).toEqual([
    { role: "model", parts: [{ ...existing, thoughtSignature: SIGNATURE }] },
    body.contents[1],
  ]);
});

function replayCall(call: unknown, signature: string): ReplayPart {
  return { type: "function-call", contentIndex: 0, partIndex: 0, call, signature };
}

async function firstCodecCall(events: readonly Record<string, unknown>[]) {
  const call = (await codecCalls(events))[0];
  if (call === undefined) throw new Error("Google codec did not emit a tool call");
  return call;
}

function completeCallFrame(call: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return contentFrame([{ functionCall: call, thoughtSignature: SIGNATURE }], "STOP");
}

function streamedCallFrames(): readonly Record<string, unknown>[] {
  return [
    contentFrame([
      {
        functionCall: {
          name: "weather",
          partialArgs: [{ jsonPath: "$.city", stringValue: "Par", willContinue: true }],
          willContinue: true,
        },
        thoughtSignature: SIGNATURE,
      },
    ]),
    contentFrame([{ functionCall: { partialArgs: [{ jsonPath: "$.city", stringValue: "is" }] } }], "STOP"),
  ];
}

function contentFrame(parts: readonly unknown[], finishReason?: string): Record<string, unknown> {
  return {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
  };
}

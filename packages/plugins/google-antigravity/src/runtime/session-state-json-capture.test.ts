import { expect, test } from "bun:test";
import { ReasoningReplayCache } from "../protocol/replay-cache";
import { captureReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);

test("captures complete JSON signatures and function calls", async () => {
  const fixture = replayFixture("json-complete");
  const captured = await captureReasoningReplay(
    Response.json({
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "reasoning", thought: true, thoughtSignature: SIGNATURE },
                { functionCall: { id: "call-1", name: "weather", args: {} }, thoughtSignature: SIGNATURE },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    }),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.json();
  expect(fixture.cache.read(fixture.scope.key)?.parts).toEqual([
    { type: "thought-signature", contentIndex: 0, partIndex: 0, signature: SIGNATURE },
    {
      type: "function-call",
      contentIndex: 0,
      partIndex: 1,
      call: { id: "call-1", name: "weather", args: {} },
      signature: SIGNATURE,
    },
  ]);
});

test.each([
  "MALFORMED_FUNCTION_CALL",
  "MAX_TOKENS",
  "IMAGE_SAFETY",
  "RECITATION",
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "FINISH_REASON_UNSPECIFIED",
  "OTHER",
  "UNEXPECTED_TOOL_CALL",
])("does not commit JSON replay for Google finish reason %s", async (finishReason) => {
  const fixture = replayFixture(`json-${finishReason}`);
  const captured = await captureReasoningReplay(
    Response.json({ response: { candidates: [{ content: signedContent("call-1"), finishReason }] } }),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.json();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit JSON replay while any candidate remains incomplete", async () => {
  const fixture = replayFixture("json-incomplete-candidate");
  const captured = await captureReasoningReplay(
    Response.json({
      response: {
        candidates: [
          { index: 0, content: signedContent("call-1"), finishReason: "STOP" },
          { index: 1, content: signedContent("call-2") },
        ],
      },
    }),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.json();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit JSON replay with duplicate explicit candidate indexes", async () => {
  const fixture = replayFixture("json-duplicate-candidate-index");
  const captured = await captureReasoningReplay(
    Response.json({
      response: {
        candidates: [
          { index: 0, content: signedContent("call-1") },
          { index: 0, content: signedContent("call-2"), finishReason: "STOP" },
        ],
      },
    }),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.json();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit JSON replay when multiple candidates finish with STOP", async () => {
  const fixture = replayFixture("json-complete-candidates");
  const captured = await captureReasoningReplay(
    Response.json({
      response: {
        candidates: [
          { index: 0, content: signedContent("call-1"), finishReason: "STOP" },
          { index: 1, content: signedContent("call-2"), finishReason: "STOP" },
        ],
      },
    }),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.json();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit mixed explicit-index and fallback-position candidates", async () => {
  const fixture = replayFixture("json-mixed-candidate-keys");
  const captured = await captureReasoningReplay(
    Response.json({
      response: {
        candidates: [
          { index: 1, content: signedContent("call-explicit"), finishReason: "STOP" },
          { content: signedContent("call-fallback"), finishReason: "STOP" },
        ],
      },
    }),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.json();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

function replayFixture(marker: string) {
  const cache = new ReasoningReplayCache();
  const scope = cache.begin(MODEL, `sha256:${marker}`, `request-${marker}`);
  return { cache, scope };
}

function signedContent(id: string) {
  return {
    role: "model",
    parts: [{ functionCall: { id, name: "tool", args: {} }, thoughtSignature: SIGNATURE }],
  };
}

import { expect, test } from "bun:test";

import { ReasoningReplayCache } from "../protocol/replay-cache";
import { captureReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);

test("does not commit signed SSE replay followed by a structured error", async () => {
  const fixture = replayFixture("late-error");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseFrame({ content: signedContent("call-1") }),
      `data: ${JSON.stringify({ error: { code: 503, message: "late failure", status: "UNAVAILABLE" } })}\n\n`,
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  expect(await captured.text()).toContain("late failure");
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit signed SSE replay without terminal completion", async () => {
  const fixture = replayFixture("truncated");
  const captured = await captureReasoningReplay(
    sseResponse([responseFrame({ content: signedContent("call-1") })]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  expect(await captured.text()).toContain("call-1");
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test.each(["data: not-json\n\n", "invalid-field: value\n\n"])(
  "does not commit signed SSE replay after parser failure",
  async (invalidFrame) => {
    const fixture = replayFixture(`invalid-${invalidFrame.length}`);
    const captured = await captureReasoningReplay(
      sseResponse([responseFrame({ content: signedContent("call-1") }), invalidFrame]),
      MODEL,
      fixture.scope,
      fixture.cache,
    );

    await captured.text();
    expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
  },
);

test("commits accumulated SSE replay only after a successful terminal response", async () => {
  const fixture = replayFixture("complete");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseFrame({ content: signedContent("call-1") }),
      responseFrame({ content: signedContent("call-2"), finishReason: "STOP" }),
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)?.parts).toMatchObject([
    { type: "function-call", contentIndex: 0, partIndex: 0, call: { id: "call-1" } },
    { type: "function-call", contentIndex: 1, partIndex: 0, call: { id: "call-2" } },
  ]);
});

test("does not commit SSE replay for MALFORMED_FUNCTION_CALL", async () => {
  const fixture = replayFixture("malformed-function-call");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseFrame({ content: signedContent("call-1"), finishReason: "MALFORMED_FUNCTION_CALL", index: 0 }),
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit SSE replay while any candidate remains incomplete", async () => {
  const fixture = replayFixture("incomplete-candidate");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseCandidatesFrame([
        { content: signedContent("call-1"), finishReason: "STOP", index: 0 },
        { content: signedContent("call-2"), index: 1 },
      ]),
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit one SSE frame with duplicate explicit candidate indexes", async () => {
  const fixture = replayFixture("duplicate-candidate-index");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseCandidatesFrame([
        { content: signedContent("call-1"), index: 0 },
        { content: signedContent("call-2"), finishReason: "STOP", index: 0 },
      ]),
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit when a later candidate starts after provisional success and then stops", async () => {
  const fixture = replayFixture("later-candidate-complete");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseFrame({ content: signedContent("call-1"), finishReason: "STOP", index: 0 }),
      responseFrame({ content: signedContent("call-2"), index: 1 }),
      responseFrame({ finishReason: "STOP", index: 1 }),
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit when a later candidate remains incomplete at EOF", async () => {
  const fixture = replayFixture("later-candidate-incomplete");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseFrame({ content: signedContent("call-1"), finishReason: "STOP", index: 0 }),
      responseFrame({ content: signedContent("call-2"), index: 1 }),
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("does not commit SSE replay after candidate content follows STOP", async () => {
  const fixture = replayFixture("content-after-stop");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseFrame({ content: signedContent("call-1"), finishReason: "STOP", index: 0 }),
      responseFrame({ content: signedContent("call-2"), index: 0 }),
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("allows a usage-only SSE frame after STOP", async () => {
  const fixture = replayFixture("usage-after-stop");
  const captured = await captureReasoningReplay(
    sseResponse([
      responseFrame({ content: signedContent("call-1"), finishReason: "STOP", index: 0 }),
      `data: ${JSON.stringify({ response: { usageMetadata: { candidatesTokenCount: 1 } } })}\n\n`,
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await captured.text();
  expect(fixture.cache.read(fixture.scope.key)?.parts).toMatchObject([
    { type: "function-call", call: { id: "call-1" } },
  ]);
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

function responseFrame(candidate: Readonly<Record<string, unknown>>): string {
  return responseCandidatesFrame([candidate]);
}

function responseCandidatesFrame(candidates: readonly Readonly<Record<string, unknown>>[]): string {
  return `data: ${JSON.stringify({ response: { candidates } })}\n\n`;
}

function sseResponse(chunks: readonly string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

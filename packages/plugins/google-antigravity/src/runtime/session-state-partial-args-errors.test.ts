import { expect, test } from "bun:test";

import { ReasoningReplayCache } from "../protocol/replay-cache";
import { captureReasoningReplay } from "./session-state";
import { appendSseReplayPayload, completedSseReplay, createSseReplayState } from "./session-state/replay-accumulator";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "partial-error-signature-".repeat(3);

test("does not complete replay while a streamed function call remains active", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, ccaPayload(startPart()));
  appendSseReplayPayload(state, MODEL, { response: { candidates: [{ index: 0, finishReason: "STOP" }] } });

  expect(completedSseReplay(state)).toBeUndefined();
});

test("does not commit malformed partialArgs", async () => {
  const fixture = replayFixture("malformed-partial-args");
  const response = await captureReasoningReplay(
    sseResponse([
      ccaPayload({
        functionCall: {
          id: "call-weather",
          name: "weather",
          partialArgs: [{ stringValue: "Paris" }],
          willContinue: true,
        },
        thoughtSignature: SIGNATURE,
      }),
      { response: { candidates: [{ index: 0, finishReason: "STOP" }] } },
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await response.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("ignores an orphan nameless partial chunk before a complete signed call", async () => {
  const fixture = replayFixture("orphan-partial-args");
  const complete = {
    functionCall: { id: "call-complete", name: "weather", args: { city: "Paris" } },
    thoughtSignature: SIGNATURE,
  };
  const response = await captureReasoningReplay(
    sseResponse([
      ccaPayload({ functionCall: { partialArgs: [{ jsonPath: "$.ignored", stringValue: "value" }] } }),
      {
        response: {
          candidates: [{ index: 0, content: { role: "model", parts: [complete] }, finishReason: "STOP" }],
        },
      },
    ]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await response.text();
  expect(fixture.cache.read(fixture.scope.key)?.parts).toMatchObject([
    { type: "function-call", call: complete.functionCall, signature: SIGNATURE },
  ]);
});

test("does not commit an active streamed call after a structured error", async () => {
  const fixture = replayFixture("partial-args-error");
  const response = await captureReasoningReplay(
    sseResponse([startPayload(), { error: { code: 503, message: "failed", status: "UNAVAILABLE" } }]),
    MODEL,
    fixture.scope,
    fixture.cache,
  );

  await response.text();
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

test("cancels an active streamed call without committing partial replay", async () => {
  const fixture = replayFixture("partial-args-cancel");
  const reason = { kind: "partial-args-cancelled" };
  let cancelled: unknown;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame(startPayload())));
    },
    cancel(value) {
      cancelled = value;
    },
  });
  const response = await captureReasoningReplay(
    new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
    MODEL,
    fixture.scope,
    fixture.cache,
  );
  const reader = response.body?.getReader();

  await reader?.read();
  await reader?.cancel(reason);
  await Promise.resolve();

  expect(cancelled).toBe(reason);
  expect(fixture.cache.read(fixture.scope.key)).toBeUndefined();
});

function replayFixture(marker: string) {
  const cache = new ReasoningReplayCache();
  const scope = cache.begin(MODEL, `sha256:${marker}`, `request-${marker}`);
  return { cache, scope };
}

function startPayload() {
  return ccaPayload(startPart());
}

function startPart() {
  return {
    functionCall: {
      id: "call-weather",
      name: "weather",
      partialArgs: [{ jsonPath: "$.city", stringValue: "Par", willContinue: true }],
      willContinue: true,
    },
    thoughtSignature: SIGNATURE,
  };
}

function ccaPayload(part: unknown) {
  return {
    response: {
      candidates: [{ index: 0, content: { role: "model", parts: [part] } }],
    },
  };
}

function sseResponse(payloads: readonly unknown[]): Response {
  return new Response(payloads.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

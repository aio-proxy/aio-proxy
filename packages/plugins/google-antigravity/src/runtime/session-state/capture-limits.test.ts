import { expect, test } from "bun:test";

import { ReasoningReplayCache } from "../../protocol/replay-cache";
import { captureReasoningReplay } from "../session-state";
import { appendSseReplayPayload, createSseReplayState, failSseReplay } from "./replay-accumulator";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "capture-limit-signature-".repeat(3);
const CAPTURE_BYTE_LIMIT = 1024 * 1024;
const CAPTURE_ENTRY_LIMIT = 1024;

test("forwards an oversized unterminated event without committing prior replay", async () => {
  const chunks = [callFrame("call-1", "STOP"), `data: ${"x".repeat(CAPTURE_BYTE_LIMIT + 1)}`];

  const captured = await capture(chunks, "unterminated");

  expect(captured.text).toBe(chunks.join(""));
  expect(captured.replay).toBeUndefined();
});

test("stops capture after cumulative valid event data exceeds one MiB", async () => {
  const chunks = [
    ...Array.from({ length: 17 }, (_, index) => callFrame(`call-${index}`, undefined, "x".repeat(64 * 1024))),
    finishFrame(),
  ];

  const captured = await capture(chunks, "cumulative-bytes");

  expect(captured.text).toBe(chunks.join(""));
  expect(captured.replay).toBeUndefined();
});

test("stops capture when retained replay parts exceed the entry ceiling", async () => {
  const chunks = [
    ...Array.from({ length: CAPTURE_ENTRY_LIMIT + 1 }, (_, index) => callFrame(`call-${index}`)),
    finishFrame(),
  ];

  const captured = await capture(chunks, "parts");

  expect(captured.text).toBe(chunks.join(""));
  expect(captured.replay).toBeUndefined();
});

test("stops capture when active partial calls exceed the entry ceiling", async () => {
  const chunks = [
    ...Array.from({ length: CAPTURE_ENTRY_LIMIT + 1 }, (_, index) => partialCallFrame(`call-${index}`)),
    ...Array.from({ length: CAPTURE_ENTRY_LIMIT + 1 }, terminalCallFrame),
    finishFrame(),
  ];

  const captured = await capture(chunks, "active-calls");

  expect(captured.text).toBe(chunks.join(""));
  expect(captured.replay).toBeUndefined();
});

test("replay failure clears accumulated parts and active partial calls", () => {
  const state = createSseReplayState();
  appendSseReplayPayload(state, MODEL, payload([completeCall("complete")]));
  appendSseReplayPayload(state, MODEL, payload([partialCall("active")]));

  expect(state.parts).toHaveLength(1);
  expect(state.streamedCalls.active.size).toBe(1);

  failSseReplay(state);

  expect(state.parts).toEqual([]);
  expect(state.streamedCalls.active.size).toBe(0);
  expect(state.candidates.size).toBe(0);
});

async function capture(chunks: readonly string[], marker: string) {
  const cache = new ReasoningReplayCache();
  const scope = cache.begin(MODEL, `sha256:${marker}`, `request-${marker}`);
  const response = await captureReasoningReplay(sseResponse(chunks), MODEL, scope, cache);
  const text = await response.text();
  return { replay: cache.read(scope.key), text };
}

function callFrame(id: string, finishReason?: string, padding?: string): string {
  return frame(payload([...(padding === undefined ? [] : [{ text: padding }]), completeCall(id)], finishReason));
}

function partialCallFrame(id: string): string {
  return frame(payload([partialCall(id)]));
}

function terminalCallFrame(): string {
  return frame(payload([{ functionCall: {} }]));
}

function finishFrame(): string {
  return frame(payload([], "STOP"));
}

function completeCall(id: string) {
  return { functionCall: { id, name: "tool", args: {} }, thoughtSignature: SIGNATURE };
}

function partialCall(id: string) {
  return {
    functionCall: {
      id,
      name: "tool",
      partialArgs: [{ jsonPath: "$.value", stringValue: "x", willContinue: true }],
      willContinue: true,
    },
    thoughtSignature: SIGNATURE,
  };
}

function payload(parts: readonly unknown[], finishReason?: string) {
  return {
    response: {
      candidates: [
        {
          index: 0,
          ...(parts.length === 0 ? {} : { content: { role: "model", parts } }),
          ...(finishReason === undefined ? {} : { finishReason }),
        },
      ],
    },
  };
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

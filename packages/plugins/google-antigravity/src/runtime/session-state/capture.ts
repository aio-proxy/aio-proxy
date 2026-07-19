import { createParser } from "eventsource-parser";
import type { ReasoningReplayCache, ReplayScope } from "../../protocol/replay-cache";
import {
  appendSseReplayPayload,
  completedSseReplay,
  createSseReplayState,
  failSseReplay,
  replayFromJsonPayload,
  type SseReplayState,
} from "./replay-accumulator";

const MAX_CAPTURE_EVENT_CHARS = 1024 * 1024;
const MAX_CAPTURE_TOTAL_BYTES = 1024 * 1024;
const MAX_CAPTURE_ENTRIES = 1024;
const encoder = new TextEncoder();

export async function captureReasoningReplay(
  response: Response,
  modelId: string,
  scope: ReplayScope,
  cache: ReasoningReplayCache,
): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  if (response.headers.get("content-type")?.includes("text/event-stream") === true) {
    return captureSse(response, modelId, scope, cache);
  }
  try {
    const replay = replayFromJsonPayload(modelId, await response.clone().json());
    if (replay !== undefined) cache.commit(scope, replay);
  } catch {
    return response;
  }
  return response;
}

function captureSse(response: Response, modelId: string, scope: ReplayScope, cache: ReasoningReplayCache): Response {
  const body = response.body;
  if (body === null) return response;
  const decoder = new TextDecoder();
  const state = createSseReplayState();
  let active = true;
  let capturedBytes = 0;
  const stopCapture = () => {
    if (!active) return;
    active = false;
    failSseReplay(state);
  };
  const parser = createParser({
    maxBufferSize: MAX_CAPTURE_EVENT_CHARS,
    onEvent(event) {
      if (!active) return;
      if (event.data.length > MAX_CAPTURE_EVENT_CHARS) {
        stopCapture();
        return;
      }
      capturedBytes += encoder.encode(event.data).byteLength;
      if (capturedBytes > MAX_CAPTURE_TOTAL_BYTES) {
        stopCapture();
        return;
      }
      try {
        appendSseReplayPayload(state, modelId, JSON.parse(event.data));
        if (replayEntryCount(state) > MAX_CAPTURE_ENTRIES) stopCapture();
      } catch {
        stopCapture();
      }
    },
    onError() {
      stopCapture();
    },
  });
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (active) {
          try {
            parser.feed(decoder.decode(chunk, { stream: true }));
          } catch {
            stopCapture();
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (!active) return;
        try {
          const tail = decoder.decode();
          if (tail !== "") parser.feed(tail);
          parser.reset({ consume: true });
        } catch {
          stopCapture();
        }
        if (!active) return;
        const replay = completedSseReplay(state);
        if (replay !== undefined) cache.commit(scope, replay);
      },
    }),
  );
  return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText });
}

function replayEntryCount(state: SseReplayState): number {
  let count = state.parts.length;
  for (const calls of state.streamedCalls.active.values()) count += calls.length;
  return count;
}

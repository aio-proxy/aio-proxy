import { createParser } from "eventsource-parser";
import type { ReasoningReplayCache, ReplayScope } from "../../protocol/replay-cache";
import {
  appendSseReplayPayload,
  completedSseReplay,
  createSseReplayState,
  failSseReplay,
  replayFromJsonPayload,
} from "./replay-accumulator";

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
  const parser = createParser({
    onEvent(event) {
      try {
        appendSseReplayPayload(state, modelId, JSON.parse(event.data));
      } catch {
        failSseReplay(state);
      }
    },
    onError() {
      failSseReplay(state);
    },
  });
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        parser.feed(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        const tail = decoder.decode();
        if (tail !== "") parser.feed(tail);
        parser.reset({ consume: true });
        const replay = completedSseReplay(state);
        if (replay !== undefined) cache.commit(scope, replay);
      },
    }),
  );
  return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText });
}

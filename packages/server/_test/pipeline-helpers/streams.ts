import type { ModelEventStream } from "@aio-proxy/core";
import type { ModelPart } from "./types";

export function jsonRequest(
  body: unknown,
  options: { readonly contentLength?: number | string; readonly signal?: AbortSignal } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.contentLength !== undefined) {
    headers.set("content-length", String(options.contentLength));
  }
  return new Request("http://localhost/v1/test", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
    method: "POST",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export function textStream(text: string): ModelEventStream {
  return new ReadableStream<ModelPart>({
    start(controller) {
      controller.enqueue({ type: "text-delta", id: "text-1", text });
      controller.enqueue(finishPart());
      controller.close();
    },
  });
}

export function emptyStream(): ModelEventStream {
  return new ReadableStream<ModelPart>({
    start(controller) {
      controller.close();
    },
  });
}

export function errorStream(error: unknown): ModelEventStream {
  return new ReadableStream<ModelPart>({
    start(controller) {
      controller.error(error);
    },
  });
}

export function textThenErrorStream(text: string, error: unknown): ModelEventStream {
  let first = true;
  return new ReadableStream<ModelPart>({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue({ type: "text-delta", id: "text-1", text });
        return;
      }
      controller.error(error);
    },
  });
}

export function cancellableTextStream(text: string, onCancel: (reason: unknown) => void): ModelEventStream {
  return new ReadableStream<ModelPart>({
    start(controller) {
      controller.enqueue({ type: "text-delta", id: "text-1", text });
    },
    cancel(reason) {
      onCancel(reason);
    },
  });
}

export async function settleRecording(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function finishPart(): ModelPart {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 },
      inputTokens: 0,
      outputTokenDetails: { reasoningTokens: 0, textTokens: 0 },
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

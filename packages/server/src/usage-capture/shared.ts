import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import type { ProviderProtocol, UsageRow } from '@aio-proxy/types';

export const MAX_PASSTHROUGH_JSON_BYTES = 1024 * 1024;

export type UsageCompletion =
  | { readonly outcome: 'success'; readonly usage?: UsageRow; readonly statusCode?: number; readonly ttftMs?: number }
  | { readonly outcome: 'failure'; readonly statusCode?: number; readonly errorCode?: string; readonly ttftMs?: number }
  | { readonly outcome: 'cancelled'; readonly statusCode?: number; readonly ttftMs?: number };

export type Captured<T> = {
  readonly value: T;
  readonly completion: Promise<UsageCompletion>;
};

export type StreamUsageOptions = {
  readonly stream: ReadableStream<TextStreamPart<ToolSet>>;
  readonly providerId: string;
  readonly modelId: string;
  // Requested inbound alias, used as a pricing fallback when the routed
  // upstream modelId is an opaque relay id absent from the price catalog.
  readonly requestedModelId?: string;
  // performance.now() at attempt dispatch; present only when streaming, so
  // ttft is recorded for streamed responses and skipped for buffered JSON.
  readonly startedAt?: number;
};

export type PassthroughUsageOptions = {
  readonly response: Response;
  readonly protocol: ProviderProtocol;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  readonly onResponseId?: (responseId: string) => void;
  // performance.now() at attempt dispatch; ttft is recorded only for SSE bodies.
  readonly startedAt?: number;
};

export type UsageCapture = {
  readonly stream: (options: StreamUsageOptions) => Captured<ReadableStream<TextStreamPart<ToolSet>>>;
  readonly passthrough: (options: PassthroughUsageOptions) => Captured<Response>;
};

export function usageProperty(usage: UsageRow | undefined): { readonly usage?: UsageRow } {
  return usage === undefined ? {} : { usage };
}

export function ttftProperty(
  startedAt: number | undefined,
  firstTokenAt: number | undefined,
): { readonly ttftMs?: number } {
  if (startedAt === undefined || firstTokenAt === undefined) return {};
  return { ttftMs: Math.max(0, Math.round(firstTokenAt - startedAt)) };
}

export function deferred<T>() {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    },
  };
}

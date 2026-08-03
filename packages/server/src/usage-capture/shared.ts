import { type OpenRouterModelPrice, type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import type { ProviderProtocol, UsageRow } from '@aio-proxy/types';

import type { AttemptResponseObservation } from '../response-observation';

export const MAX_PASSTHROUGH_JSON_BYTES = 1024 * 1024;

export const STREAM_IDLE_TIMEOUT_MS = 300_000;

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
  readonly observation?: AttemptResponseObservation;
  // Upstream idle timeout in ms; when the stream produces no data for this long,
  // completion resolves failure and the upstream is cancelled. Defaults to
  // STREAM_IDLE_TIMEOUT_MS; image endpoints should pass a larger value.
  readonly idleTimeoutMs?: number;
  // Per-provider price override for the hit channel; when present it wins over
  // the models.dev catalog and marks the usage row's priceSource as 'config'.
  readonly configPrice?: OpenRouterModelPrice;
};

export type PassthroughUsageOptions = {
  readonly response: Response;
  readonly protocol: ProviderProtocol;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  // Fired at the terminal frame with the upstream response ID, for trace
  // persistence. Resolves alongside completion so the finished trace records the
  // ID even when the terminal frame precedes stream EOF.
  readonly onResponseId?: (responseId: string) => void;
  // Fired only once the client drains the stream to EOF, for logical-session
  // commit. Gated on EOF (not the terminal frame) so a client that cancels
  // before EOF does not commit the response.
  readonly onCommit?: (responseId: string) => void;
  // performance.now() at attempt dispatch; ttft is recorded only for SSE bodies.
  readonly startedAt?: number;
  readonly observation?: AttemptResponseObservation;
  // Upstream idle timeout in ms; when the stream produces no bytes for this long,
  // completion resolves failure and the upstream is cancelled. Defaults to
  // STREAM_IDLE_TIMEOUT_MS; image endpoints should pass a larger value.
  readonly idleTimeoutMs?: number;
  // Per-provider price override for the hit channel; when present it wins over
  // the models.dev catalog and marks the usage row's priceSource as 'config'.
  readonly configPrice?: OpenRouterModelPrice;
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

export function observeContentAt(observation: AttemptResponseObservation | undefined): number {
  try {
    return observation?.observeContent() ?? performance.now();
  } catch {
    return performance.now();
  }
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

export type IdleTimer = {
  // Re-arm the timer, cancelling any prior pending fire. Call after each unit
  // of stream progress so the timeout measures gaps between data, not total time.
  readonly arm: () => void;
  // Cancel any pending fire without re-arming. Call once the stream settles.
  readonly clear: () => void;
};

// Fires onIdle when arm() is not called again within idleMs. A non-positive
// idleMs disables the timer entirely. Shared by the passthrough and AI SDK
// stream capture paths so both get identical upstream-stall handling.
export function createIdleTimer(idleMs: number, onIdle: () => void): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    clear,
    arm: () => {
      clear();
      if (idleMs <= 0) return;
      timer = setTimeout(onIdle, idleMs);
    },
  };
}

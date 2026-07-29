import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import type { ProviderProtocol, UsageRow } from '@aio-proxy/types';

import {
  createPassthroughSseUsageObserver,
  extractPassthroughObservation,
  type PassthroughObservation,
  type PassthroughSseUsageObserver,
} from '../passthrough-usage';
import { isAbortError } from '../route-observation';
import type { ServerLogSink } from '../server-log';
import { normalizeAiSdkUsage } from './pricing';
import { finalizeUsage } from './usage-validation';

const MAX_PASSTHROUGH_JSON_BYTES = 1024 * 1024;

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

export function createUsageCapture(options: { readonly logger?: ServerLogSink } = {}): UsageCapture {
  return {
    stream: (streamOptions) => streamCapture(streamOptions, options.logger),
    passthrough: (passthroughOptions) => passthroughCapture(passthroughOptions, options.logger),
  };
}

function streamCapture(
  { stream, providerId, modelId, requestedModelId, startedAt }: StreamUsageOptions,
  logger: ServerLogSink | undefined,
): Captured<ReadableStream<TextStreamPart<ToolSet>>> {
  const terminal = deferred<UsageCompletion>();
  const reader = stream.getReader();
  let cancelled = false;
  let aborted = false;
  let finished = false;
  let finishUsage: UsageRow | undefined;
  let firstTokenAt: number | undefined;
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  const value = new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          releaseReader();
          if (cancelled) return;
          controller.close();
          terminal.resolve(
            aborted
              ? { outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) }
              : finished
                ? {
                    outcome: 'success',
                    ...usageProperty(
                      await finalizeUsage({
                        usage: finishUsage,
                        accounting: { source: 'ai-sdk' },
                        ...(requestedModelId === undefined ? {} : { requestedModelId }),
                        ...(logger === undefined ? {} : { logger }),
                      }),
                    ),
                    ...ttftProperty(startedAt, firstTokenAt),
                  }
                : { outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) },
          );
          return;
        }
        if (next.value.type === 'finish') {
          finished = true;
          finishUsage = normalizeAiSdkUsage(next.value, providerId, modelId);
        } else if (next.value.type === 'abort') {
          aborted = true;
        } else if (
          firstTokenAt === undefined &&
          startedAt !== undefined &&
          (next.value.type === 'text-delta' || next.value.type === 'reasoning-delta')
        ) {
          firstTokenAt = performance.now();
        }
        controller.enqueue(next.value);
      } catch (error) {
        releaseReader();
        if (cancelled || isAbortError(error)) {
          terminal.resolve({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
        } else {
          terminal.resolve({ outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) });
        }
        if (!cancelled) {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      cancelled = true;
      terminal.resolve({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  return { value, completion: terminal.promise };
}

function passthroughCapture(
  { response, protocol, providerId, modelId, requestedModelId, onResponseId, startedAt }: PassthroughUsageOptions,
  logger: ServerLogSink | undefined,
): Captured<Response> {
  if (response.status < 200 || response.status >= 400) {
    return { value: response, completion: Promise.resolve({ outcome: 'failure', statusCode: response.status }) };
  }
  if (response.body === null) {
    return { value: response, completion: Promise.resolve({ outcome: 'success', statusCode: response.status }) };
  }

  const statusCode = response.status;
  const terminal = deferred<UsageCompletion>();
  const reader = response.body.getReader();
  const isSse = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true;
  const sseObserver = isSse ? createPassthroughSseUsageObserver(protocol) : undefined;
  const decoder = isSse ? new TextDecoder() : undefined;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let captureJson = !isSse;
  let firstTokenAt: number | undefined;
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const returnedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let done = false;
      try {
        const next = await reader.read();
        if (!next.done) {
          if (sseObserver !== undefined && decoder !== undefined) {
            sseObserver.feed(decoder.decode(next.value, { stream: true }));
            // Align TTFT with the first content token, not the first byte: only
            // mark it once the observer has parsed a generated text/reasoning delta.
            if (firstTokenAt === undefined && startedAt !== undefined && sseObserver.sawContent()) {
              firstTokenAt = performance.now();
            }
          } else if (captureJson) {
            const nextByteLength = byteLength + next.value.byteLength;
            if (nextByteLength <= MAX_PASSTHROUGH_JSON_BYTES) {
              chunks.push(next.value);
              byteLength = nextByteLength;
            } else {
              chunks.length = 0;
              byteLength = 0;
              captureJson = false;
            }
          }
          controller.enqueue(next.value);
          return;
        }

        done = true;
        controller.close();
        const observation =
          sseObserver !== undefined && decoder !== undefined
            ? finishSseObservation(sseObserver, decoder)
            : captureJson
              ? extractPassthroughObservation(protocol, decodeChunks(chunks, byteLength))
              : {};
        if (observation.failed === true) {
          terminal.resolve({ outcome: 'failure', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
          return;
        }
        const usage = await finalizeUsage({
          usage:
            observation.usage === undefined && observation.issues === undefined
              ? undefined
              : { ...observation.usage, providerId, modelId },
          accounting: { source: 'passthrough', protocol },
          ...(requestedModelId === undefined ? {} : { requestedModelId }),
          ...(logger === undefined ? {} : { logger }),
          ...(observation.issues === undefined ? {} : { issues: observation.issues }),
        });
        if (observation.responseId !== undefined) onResponseId?.(observation.responseId);
        terminal.resolve({
          outcome: 'success',
          statusCode,
          ...usageProperty(usage),
          ...ttftProperty(startedAt, firstTokenAt),
        });
      } catch (error) {
        done = true;
        terminal.resolve({
          outcome: isAbortError(error) ? 'cancelled' : 'failure',
          statusCode,
          ...ttftProperty(startedAt, firstTokenAt),
        });
        controller.error(error);
      } finally {
        if (done) releaseReader();
      }
    },
    async cancel(reason) {
      terminal.resolve({ outcome: 'cancelled', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  return {
    value: new Response(returnedBody, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }),
    completion: terminal.promise,
  };
}

function finishSseObservation(observer: PassthroughSseUsageObserver, decoder: TextDecoder): PassthroughObservation {
  observer.feed(decoder.decode());
  return observer.finish();
}

function decodeChunks(chunks: readonly Uint8Array[], byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function usageProperty(usage: UsageRow | undefined): { readonly usage?: UsageRow } {
  return usage === undefined ? {} : { usage };
}

function ttftProperty(startedAt: number | undefined, firstTokenAt: number | undefined): { readonly ttftMs?: number } {
  if (startedAt === undefined || firstTokenAt === undefined) return {};
  return { ttftMs: Math.max(0, Math.round(firstTokenAt - startedAt)) };
}

function deferred<T>() {
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

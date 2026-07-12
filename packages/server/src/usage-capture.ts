import {
  calculateEstimatedCost,
  type OpenRouterPriceCatalog,
  type TextStreamPart,
  type ToolSet,
} from "@aio-proxy/core";
import type { ProviderProtocol, UsageRow } from "@aio-proxy/types";
import {
  createPassthroughSseUsageObserver,
  extractPassthroughUsage,
  type PassthroughSseUsageObserver,
} from "./passthrough-usage";
import { isAbortError } from "./route-observation";

type FinishPart = Extract<TextStreamPart<ToolSet>, { readonly type: "finish" }>;
const MAX_PASSTHROUGH_JSON_BYTES = 1024 * 1024;

export type UsageCompletion =
  | { readonly outcome: "success"; readonly usage?: UsageRow; readonly statusCode?: number }
  | { readonly outcome: "failure"; readonly statusCode?: number; readonly errorCode?: string }
  | { readonly outcome: "cancelled"; readonly statusCode?: number };

export type Captured<T> = {
  readonly value: T;
  readonly completion: Promise<UsageCompletion>;
};

export type StreamUsageOptions = {
  readonly stream: ReadableStream<TextStreamPart<ToolSet>>;
  readonly providerId: string;
  readonly modelId: string;
};

export type PassthroughUsageOptions = {
  readonly response: Response;
  readonly protocol: ProviderProtocol;
  readonly providerId: string;
  readonly modelId: string;
};

export type UsageCapture = {
  readonly stream: (options: StreamUsageOptions) => Captured<ReadableStream<TextStreamPart<ToolSet>>>;
  readonly passthrough: (options: PassthroughUsageOptions) => Captured<Response>;
};

export function createUsageCapture(options: {
  readonly priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>;
}): UsageCapture {
  return {
    stream({ stream, providerId, modelId }) {
      const terminal = deferred<UsageCompletion>();
      const reader = stream.getReader();
      let cancelled = false;
      let aborted = false;
      let finished = false;
      let finishUsage: UsageRow | undefined;

      const value = new ReadableStream<TextStreamPart<ToolSet>>({
        async start(controller) {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                break;
              }
              if (next.value.type === "finish") {
                finished = true;
                finishUsage = normalizeAiSdkUsage(next.value, providerId, modelId);
              } else if (next.value.type === "abort") {
                aborted = true;
              }
              controller.enqueue(next.value);
            }
            if (cancelled) {
              return;
            }
            controller.close();
            terminal.resolve(
              aborted
                ? { outcome: "cancelled" }
                : finished
                  ? { outcome: "success", ...usageProperty(await priceUsage(finishUsage, options.priceCatalogTask)) }
                  : { outcome: "failure" },
            );
          } catch (error) {
            if (cancelled || isAbortError(error)) {
              terminal.resolve({ outcome: "cancelled" });
            } else {
              terminal.resolve({ outcome: "failure" });
            }
            if (!cancelled) {
              controller.error(error);
            }
          } finally {
            reader.releaseLock();
          }
        },
        async cancel(reason) {
          cancelled = true;
          terminal.resolve({ outcome: "cancelled" });
          await reader.cancel(reason);
        },
      });

      return { value, completion: terminal.promise };
    },

    passthrough({ response, protocol, providerId, modelId }) {
      if (response.status < 200 || response.status >= 400) {
        return { value: response, completion: Promise.resolve({ outcome: "failure", statusCode: response.status }) };
      }
      if (response.body === null) {
        return { value: response, completion: Promise.resolve({ outcome: "success", statusCode: response.status }) };
      }

      const statusCode = response.status;
      const terminal = deferred<UsageCompletion>();
      const reader = response.body.getReader();
      const isSse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
      const sseObserver = isSse ? createPassthroughSseUsageObserver(protocol) : undefined;
      const decoder = isSse ? new TextDecoder() : undefined;
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      let captureJson = !isSse;
      let released = false;
      const releaseReader = () => {
        if (!released) {
          released = true;
          reader.releaseLock();
        }
      };
      const returnedBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          let done = false;
          try {
            const next = await reader.read();
            if (!next.done) {
              if (sseObserver !== undefined && decoder !== undefined) {
                sseObserver.feed(decoder.decode(next.value, { stream: true }));
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
            const extracted =
              sseObserver !== undefined && decoder !== undefined
                ? finishSseObservation(sseObserver, decoder)
                : captureJson
                  ? extractPassthroughUsage(protocol, decodeChunks(chunks, byteLength))
                  : undefined;
            const usage = await priceUsage(
              extracted === undefined ? undefined : { ...extracted, providerId, modelId },
              options.priceCatalogTask,
            );
            terminal.resolve({ outcome: "success", statusCode, ...usageProperty(usage) });
          } catch (error) {
            done = true;
            terminal.resolve({ outcome: isAbortError(error) ? "cancelled" : "failure", statusCode });
            controller.error(error);
          } finally {
            if (done) {
              releaseReader();
            }
          }
        },
        async cancel(reason) {
          terminal.resolve({ outcome: "cancelled", statusCode });
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
    },
  };
}

function finishSseObservation(observer: PassthroughSseUsageObserver, decoder: TextDecoder) {
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

function normalizeAiSdkUsage(part: FinishPart, providerId: string, modelId: string): UsageRow | undefined {
  const usage = part.totalUsage;
  const normalized = {
    providerId,
    modelId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.inputTokenDetails?.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.inputTokenDetails?.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }),
    ...(usage.outputTokenDetails?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
  };
  return Object.keys(normalized).length === 2 ? undefined : normalized;
}

async function priceUsage(
  usage: UsageRow | undefined,
  priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>,
): Promise<UsageRow | undefined> {
  if (usage === undefined) {
    return undefined;
  }
  try {
    const price = (await priceCatalogTask())?.find(usage.modelId);
    const cost = price === undefined ? undefined : calculateEstimatedCost(pricingInput(usage), price);
    return cost === undefined ? usage : { ...usage, ...cost };
  } catch {
    return usage;
  }
}

function pricingInput(usage: UsageRow) {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

function usageProperty(usage: UsageRow | undefined): { readonly usage?: UsageRow } {
  return usage === undefined ? {} : { usage };
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

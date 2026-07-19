import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD } from "../oauth/constants";
import { antigravityReplayCache, type ReasoningReplayCache } from "../protocol/replay-cache";
import type { GoogleAntigravityAccountOptions } from "../schema";
import type { AntigravityCredentialSource } from "./credential";
import { antigravityEndpoints } from "./endpoints";
import { type CcaRequestType, createCcaEnvelope } from "./envelope";
import { hasExplicitNoCapacity } from "./error-response";
import { type AntigravityEndpointCategory, type AntigravityFailureReason, AntigravityUpstreamError } from "./errors";
import { createCcaHeaders } from "./headers";
import { retryAfterMilliseconds } from "./retry-after";
import { captureReasoningReplay, isSignatureInvalidResponse, prepareReasoningReplay } from "./session-state";
import { preflightCcaSse } from "./stream";

const GENERATE_PATH = "/v1internal:generateContent";
const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";
const COUNT_PATH = "/v1internal:countTokens";

export type AntigravityExecuteInput = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly context: LogicalRequestContext;
  readonly modelId: string;
  readonly requestType: CcaRequestType;
  readonly stream: boolean;
  readonly operation?: "countTokens";
  readonly signal?: AbortSignal;
};

export type AntigravityTransportDependencies = {
  readonly credentials: AntigravityCredentialSource;
  readonly options?: GoogleAntigravityAccountOptions;
  readonly fetch?: typeof globalThis.fetch;
  readonly replayCache?: ReasoningReplayCache;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export type CcaTransport = {
  readonly execute: (input: AntigravityExecuteInput) => Promise<Response>;
};

export class AntigravityTransport implements CcaTransport {
  readonly #credentials: AntigravityCredentialSource;
  readonly #options: GoogleAntigravityAccountOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #replayCache: ReasoningReplayCache;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(dependencies: AntigravityTransportDependencies) {
    this.#credentials = dependencies.credentials;
    this.#options = dependencies.options ?? {};
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#replayCache = dependencies.replayCache ?? antigravityReplayCache;
    this.#sleep = dependencies.sleep ?? Bun.sleep;
  }

  async execute(input: AntigravityExecuteInput): Promise<Response> {
    throwIfCallerAborted(input.signal);
    let credential = await this.#credentials.current(input.signal);
    throwIfCallerAborted(input.signal);
    const scope = this.#replayCache.begin(input.modelId, input.context.session.key, input.context.requestId);
    const replayBody = prepareReasoningReplay(input.body, input.modelId, this.#replayCache.read(scope.key));
    let body = JSON.stringify(createCcaEnvelope({ ...input, body: replayBody, credential }));
    let authRefreshUsed = false;
    let lastFailure: AntigravityUpstreamError | undefined;
    let signatureRetryUsed = false;
    const endpoints = antigravityEndpoints(this.#options, "inference");

    for (const endpoint of endpoints) {
      const category = endpointCategory(endpoint, this.#options);
      let shortRetryUsed = false;
      for (;;) {
        throwIfCallerAborted(input.signal);
        let response: Response;
        try {
          response = await this.#fetch(`${endpoint}${requestPath(input)}`, {
            method: "POST",
            headers: createCcaHeaders(credential, input.stream),
            body,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        } catch (error) {
          throwIfCallerAborted(input.signal);
          if (!isRetryableNetworkFailure(error)) throw error;
          lastFailure = upstreamError(category, "upstream_network");
          break;
        }
        throwIfCallerAborted(input.signal);

        if ((response.status === 401 || response.status === 403) && !authRefreshUsed) {
          await discard(response);
          credential = await this.#credentials.forceRefresh(input.signal);
          authRefreshUsed = true;
          continue;
        }

        if (response.status === 429 && !shortRetryUsed) {
          const delay = retryAfterMilliseconds(response.headers.get("retry-after"));
          if (delay < 3_000) {
            await discard(response);
            shortRetryUsed = true;
            await sleepWithSignal(this.#sleep, delay, input.signal);
            continue;
          }
        }

        if (
          response.status === 400 &&
          replayBody !== input.body &&
          !signatureRetryUsed &&
          (await isSignatureInvalidResponse(response, input.signal))
        ) {
          this.#replayCache.clear(scope);
          await discard(response);
          signatureRetryUsed = true;
          body = JSON.stringify(createCcaEnvelope({ ...input, credential, body: input.body }));
          continue;
        }

        const failure = await retryableResponse(response, category, input.signal);
        if (failure !== undefined) {
          lastFailure = failure;
          await discard(response);
          break;
        }

        if (input.stream && response.ok) {
          try {
            const preflight = await preflightCcaSse(response);
            if (preflight.event?.kind === "retryable-error") {
              lastFailure = upstreamError(category, preflight.event.reason, preflight.event.status);
              await discard(preflight.response);
              break;
            }
            return await captureReasoningReplay(preflight.response, input.modelId, scope, this.#replayCache);
          } catch (error) {
            throwIfCallerAborted(input.signal);
            if (!isRetryableNetworkFailure(error)) throw error;
            lastFailure = upstreamError(category, "upstream_network");
            break;
          }
        }

        return await captureReasoningReplay(response, input.modelId, scope, this.#replayCache);
      }
    }

    throw lastFailure ?? upstreamError("custom", "upstream_network");
  }
}

function requestPath(input: AntigravityExecuteInput): string {
  if (input.operation === "countTokens") return COUNT_PATH;
  return input.stream ? STREAM_PATH : GENERATE_PATH;
}

async function retryableResponse(
  response: Response,
  category: AntigravityEndpointCategory,
  signal: AbortSignal | undefined,
): Promise<AntigravityUpstreamError | undefined> {
  if (response.status === 429) return upstreamError(category, "upstream_rate_limited", 429);
  if (response.status !== 503) return undefined;
  return (await hasExplicitNoCapacity(response, signal))
    ? upstreamError(category, "upstream_no_capacity", 503)
    : undefined;
}

async function sleepWithSignal(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return await sleep(milliseconds);
  throwIfCallerAborted(signal);
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      const reason: unknown = signal.reason;
      reject(reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function endpointCategory(endpoint: string, options: GoogleAntigravityAccountOptions): AntigravityEndpointCategory {
  if (options.baseURL !== undefined) return "custom";
  if (endpoint === ANTIGRAVITY_DAILY) return "daily";
  if (endpoint === ANTIGRAVITY_PROD) return "prod";
  return "custom";
}

function upstreamError(
  endpoint: AntigravityEndpointCategory,
  reason: AntigravityFailureReason,
  status?: number,
): AntigravityUpstreamError {
  return new AntigravityUpstreamError({ endpoint, reason, ...(status === undefined ? {} : { status }) });
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  throw reason ?? new DOMException("The operation was aborted", "AbortError");
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRetryableNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return isRetryableNetworkCode(Reflect.get(error, "code")) || isRetryableNetworkCode(Reflect.get(error, "cause"));
}

function isRetryableNetworkCode(value: unknown): boolean {
  if (typeof value === "string") return RETRYABLE_NETWORK_CODES.has(value);
  if (typeof value !== "object" || value === null) return false;
  const code = Reflect.get(value, "code");
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

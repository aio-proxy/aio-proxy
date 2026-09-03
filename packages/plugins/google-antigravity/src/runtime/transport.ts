import type { LogicalRequestContext, ModelDescriptor, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import type { AntigravityFamily } from '../catalog/collapse';
import { ANTIGRAVITY_DAILY, ANTIGRAVITY_SANDBOX } from '../oauth/constants';
import { antigravityReplayCache, type ReasoningReplayCache } from '../protocol/replay-cache';
import type { GoogleAntigravityAccountOptions } from '../schema';
import type { AntigravityCredentialSource } from './credential';
import { antigravityEndpoints } from './endpoints';
import {
  type AntigravityRequestSession,
  type CcaRequestType,
  type CcaWireLookups,
  createCcaEnvelope,
  readCcaResponseId,
} from './envelope';
import { hasExplicitNoCapacity } from './error-response';
import { type AntigravityEndpointCategory, type AntigravityFailureReason, AntigravityUpstreamError } from './errors';
import { createCcaHeaders } from './headers';
import { retryAfterMilliseconds } from './retry-after';
import { captureReasoningReplay, isSignatureInvalidResponse, prepareReasoningReplay } from './session-state';
import { applyGeminiSkipThoughtSignature } from './session-state/prepare/skip-signature';
import { preflightCcaSse } from './stream';

const GENERATE_PATH = '/v1internal:generateContent';
const STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse';
const COUNT_PATH = '/v1internal:countTokens';
const lastGoodByProject = new Map<string, string>();
const SESSION_TTL_MS = 3_600_000;
const SESSION_MAX_ENTRIES = 10_240;
const sessions = new Map<SessionStateKey, SessionRecord>();

type SessionStateKey = `${string}\u0000sha256:${string}`;
type SessionRecord = AntigravityRequestSession & { expiresAt: number; lastAccessAt: number };

export type AntigravityExecuteInput = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly context: LogicalRequestContext;
  readonly modelId: string;
  readonly requestType: CcaRequestType;
  readonly stream: boolean;
  readonly operation?: 'countTokens';
  readonly signal?: AbortSignal;
};

export type AntigravityTransportDependencies = {
  readonly credentials: AntigravityCredentialSource;
  readonly options?: GoogleAntigravityAccountOptions;
  readonly fetch?: RuntimeFetch;
  readonly replayCache?: ReasoningReplayCache;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly descriptorById?: ReadonlyMap<string, ModelDescriptor>;
  readonly familyByWireId?: (modelId: string) => AntigravityFamily | undefined;
  readonly now?: () => number;
};

export type CcaTransport = {
  readonly execute: (input: AntigravityExecuteInput) => Promise<Response>;
};

export class AntigravityTransport implements CcaTransport {
  readonly #credentials: AntigravityCredentialSource;
  readonly #options: GoogleAntigravityAccountOptions;
  readonly #fetch: RuntimeFetch;
  readonly #replayCache: ReasoningReplayCache;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #lookups: CcaWireLookups;
  readonly #now: () => number;

  constructor(dependencies: AntigravityTransportDependencies) {
    this.#credentials = dependencies.credentials;
    this.#options = dependencies.options ?? {};
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#replayCache = dependencies.replayCache ?? antigravityReplayCache;
    this.#sleep = dependencies.sleep ?? Bun.sleep;
    this.#now = dependencies.now ?? Date.now;
    this.#lookups = {
      descriptorById: dependencies.descriptorById ?? new Map(),
      familyByWireId: dependencies.familyByWireId ?? (() => undefined),
    };
  }

  async execute(input: AntigravityExecuteInput): Promise<Response> {
    throwIfCallerAborted(input.signal);
    let credential = await this.#credentials.current(input.signal);
    throwIfCallerAborted(input.signal);
    const scope = this.#replayCache.begin(input.modelId, input.context.session.key, input.context.requestId);
    const replayBody = prepareReasoningReplay(input.body, input.modelId, this.#replayCache.read(scope.key));
    const sessionState =
      input.operation === 'countTokens'
        ? ephemeralSessionState()
        : nextSessionState(sessionStateKey(input.modelId, input.context.session.key), this.#now);
    let body = JSON.stringify(
      createCcaEnvelope({ ...input, ...this.#lookups, body: replayBody, credential, sessionState }),
    );
    let authRefreshUsed = false;
    let lastFailure: AntigravityUpstreamError | undefined;
    let signatureRetryUsed = false;
    const endpoints = antigravityEndpoints(this.#options, 'inference', lastGoodByProject.get(credential.projectId));

    for (const endpoint of endpoints) {
      const category = endpointCategory(endpoint, this.#options);
      let shortRetryUsed = false;
      for (;;) {
        throwIfCallerAborted(input.signal);
        let response: Response;
        try {
          response = await this.#fetch(`${endpoint}${requestPath(input)}`, {
            method: 'POST',
            headers: createCcaHeaders(credential, input.stream),
            body,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
        } catch (error) {
          throwIfCallerAborted(input.signal);
          if (!isRetryableNetworkFailure(error)) throw error;
          lastFailure = upstreamError(category, 'upstream_network');
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
          const delay = retryAfterMilliseconds(response.headers.get('retry-after'));
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
          body = JSON.stringify(
            createCcaEnvelope({
              ...input,
              ...this.#lookups,
              credential,
              body: applyGeminiSkipThoughtSignature(input.body, input.modelId),
              sessionState,
            }),
          );
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
            if (preflight.event?.kind === 'retryable-error') {
              lastFailure = upstreamError(category, preflight.event.reason, preflight.event.status);
              await discard(preflight.response);
              break;
            }
            rememberLastGood(credential.projectId, endpoint);
            if (input.operation !== 'countTokens') {
              rememberLastExecution(
                sessionStateKey(input.modelId, input.context.session.key),
                sessionState,
                readCcaResponseId(preflight.payload),
              );
            }
            return await captureReasoningReplay(preflight.response, input.modelId, scope, this.#replayCache);
          } catch (error) {
            throwIfCallerAborted(input.signal);
            if (!isRetryableNetworkFailure(error)) throw error;
            lastFailure = upstreamError(category, 'upstream_network');
            break;
          }
        }

        if (response.ok) {
          rememberLastGood(credential.projectId, endpoint);
          if (input.operation !== 'countTokens') {
            rememberLastExecution(
              sessionStateKey(input.modelId, input.context.session.key),
              sessionState,
              await readJsonResponseId(response),
            );
          }
        }
        return await captureReasoningReplay(response, input.modelId, scope, this.#replayCache);
      }
    }

    throw lastFailure ?? upstreamError('custom', 'upstream_network');
  }
}

function rememberLastGood(projectId: string, origin: string): void {
  lastGoodByProject.set(projectId, origin);
}

function sessionStateKey(modelId: string, sessionKey: `sha256:${string}`): SessionStateKey {
  return `${modelId}\u0000${sessionKey}`;
}

function nextSessionState(key: SessionStateKey, now: () => number): AntigravityRequestSession {
  const clock = now();
  pruneSessions(clock);
  const current = sessions.get(key);
  if (current === undefined || current.expiresAt <= clock) {
    const created: SessionRecord = {
      agentId: crypto.randomUUID(),
      trajectoryId: crypto.randomUUID(),
      stepIndex: 1,
      expiresAt: clock + SESSION_TTL_MS,
      lastAccessAt: clock,
    };
    sessions.set(key, created);
    evictSessions();
    return created;
  }
  const next: SessionRecord = {
    ...current,
    stepIndex: current.stepIndex + 1,
    expiresAt: clock + SESSION_TTL_MS,
    lastAccessAt: clock,
  };
  sessions.set(key, next);
  return next;
}

function ephemeralSessionState(): AntigravityRequestSession {
  return {
    agentId: crypto.randomUUID(),
    trajectoryId: crypto.randomUUID(),
    stepIndex: 2,
  };
}

function pruneSessions(now: number): void {
  for (const [key, record] of sessions) {
    if (record.expiresAt <= now) sessions.delete(key);
  }
}

function evictSessions(): void {
  while (sessions.size > SESSION_MAX_ENTRIES) {
    let oldestKey: SessionStateKey | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, record] of sessions) {
      if (record.lastAccessAt < oldestAccess) {
        oldestAccess = record.lastAccessAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return;
    sessions.delete(oldestKey);
  }
}

function rememberLastExecution(
  key: SessionStateKey,
  sessionState: AntigravityRequestSession,
  responseId: string | undefined,
): void {
  const stored = sessions.get(key);
  if (stored === undefined) return;
  if (stored.agentId !== sessionState.agentId || stored.trajectoryId !== sessionState.trajectoryId) return;
  if (stored.stepIndex !== sessionState.stepIndex) return;
  if (responseId === undefined) {
    const { lastExecutionId: _dropped, ...rest } = stored;
    sessions.set(key, rest);
    return;
  }
  sessions.set(key, { ...stored, lastExecutionId: responseId });
}

async function readJsonResponseId(response: Response): Promise<string | undefined> {
  try {
    return readCcaResponseId(await response.clone().json());
  } catch {
    return undefined;
  }
}

function requestPath(input: AntigravityExecuteInput): string {
  if (input.operation === 'countTokens') return COUNT_PATH;
  return input.stream ? STREAM_PATH : GENERATE_PATH;
}

async function retryableResponse(
  response: Response,
  category: AntigravityEndpointCategory,
  signal: AbortSignal | undefined,
): Promise<AntigravityUpstreamError | undefined> {
  if (response.status === 429) return upstreamError(category, 'upstream_rate_limited', 429);
  if (response.status !== 503) return undefined;
  return (await hasExplicitNoCapacity(response, signal))
    ? upstreamError(category, 'upstream_no_capacity', 503)
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
      reject(reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function endpointCategory(endpoint: string, options: GoogleAntigravityAccountOptions): AntigravityEndpointCategory {
  if (options.baseURL !== undefined) return 'custom';
  if (endpoint === ANTIGRAVITY_DAILY) return 'daily';
  if (endpoint === ANTIGRAVITY_SANDBOX) return 'sandbox';
  return 'custom';
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
  throw reason ?? new DOMException('The operation was aborted', 'AbortError');
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isRetryableNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return isRetryableNetworkCode(Reflect.get(error, 'code')) || isRetryableNetworkCode(Reflect.get(error, 'cause'));
}

function isRetryableNetworkCode(value: unknown): boolean {
  if (typeof value === 'string') return RETRYABLE_NETWORK_CODES.has(value);
  if (typeof value !== 'object' || value === null) return false;
  const code = Reflect.get(value, 'code');
  return typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code);
}

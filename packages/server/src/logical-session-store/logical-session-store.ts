import { hashSession, normalizeSessionValue, type ProtocolSessionHints, selectSessionCandidate } from '@aio-proxy/core';
import type { LogicalRequestContext, LogicalSessionSource } from '@aio-proxy/plugin-sdk';

import { logServerEvent, type ServerLogSink } from '../server-log';

export type LogicalSessionInput = {
  readonly requestId?: string;
  readonly requestedModelId?: string;
  readonly hints: ProtocolSessionHints;
  readonly headers: Headers;
  readonly internalSessionId?: string;
};

export type SessionIdentity = {
  readonly source: LogicalSessionSource;
  readonly id: string;
};

export type SessionAffinityObservation = {
  readonly providerId: string;
  readonly revision: number;
  readonly active: boolean;
};

export type LogicalSessionResolution = LogicalRequestContext & {
  readonly context: LogicalRequestContext;
  readonly identity: SessionIdentity;
  readonly resolvedBy: LogicalSessionSource;
  readonly affinity?: SessionAffinityObservation;
};

export type LogicalSessionRepository = {
  readonly resolveResponse: (responseId: string, now: Date) => SessionIdentity | undefined;
  readonly findAffinity: (
    identity: SessionIdentity,
    requestedModelId: string,
    now: Date,
  ) => SessionAffinityObservation | undefined;
};

const NOOP_REPOSITORY: LogicalSessionRepository = {
  resolveResponse: () => undefined,
  findAffinity: () => undefined,
};

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_ENTRIES = 10_240;

type ResponseSession = { readonly sessionKey: `sha256:${string}`; accessedAt: number };

export type LogicalSessionStoreOptions = {
  readonly repository?: LogicalSessionRepository;
  readonly logger?: ServerLogSink;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
};

type SelectedSession = LogicalRequestContext['session'];

export class LogicalSessionStore {
  readonly #repository: LogicalSessionRepository;
  readonly #logger: ServerLogSink | undefined;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #responses = new Map<string, ResponseSession>();

  constructor(options: LogicalSessionStoreOptions = {}) {
    this.#repository = options.repository ?? NOOP_REPOSITORY;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  begin(input: LogicalSessionInput): LogicalSessionResolution {
    const now = this.#now();
    const requestId = input.requestId ?? crypto.randomUUID();
    const requestedModelId = input.requestedModelId ?? 'unknown';
    const selected = this.#select(input, now, requestId);
    const context: LogicalRequestContext = { requestId, session: selected.session };

    const affinity =
      selected.resolvedBy === 'generated'
        ? undefined
        : this.#safeFindAffinity(selected.identity, requestedModelId, now, requestId);

    return {
      ...context,
      context,
      identity: selected.identity,
      resolvedBy: selected.resolvedBy,
      ...(affinity === undefined ? {} : { affinity }),
    };
  }

  /**
   * Transitional in-memory write path. Production writes move to the terminal
   * TraceStore transaction in Task 5; this keeps isolated route fixtures working
   * and serves as a fallback when no repository is injected.
   */
  commitResponse(responseId: string, sessionKey: `sha256:${string}`): void {
    const normalized = normalizeSessionValue(responseId);
    if (normalized === undefined) return;
    this.#responses.set(normalized, { sessionKey, accessedAt: this.#now().getTime() });
    while (this.#responses.size > this.#maxEntries) this.#evictOldest();
  }

  #select(
    input: LogicalSessionInput,
    now: Date,
    requestId: string,
  ): { session: SelectedSession; identity: SessionIdentity; resolvedBy: LogicalSessionSource } {
    const internal = this.#internalCandidate(input.internalSessionId);
    if (internal !== undefined) return internal;

    const candidate = this.#firstCandidate(input.hints.candidates);
    if (candidate !== undefined) return candidate;

    const header = this.#headerCandidate(input.headers);
    if (header !== undefined) return header;

    const previous = this.#previousResponse(input.hints.previousResponseId, now, requestId);
    if (previous !== undefined) return previous;

    const identity: SessionIdentity = { source: 'generated', id: crypto.randomUUID() };
    return {
      session: { key: hashSession('generated', identity.id), source: 'generated' },
      identity,
      resolvedBy: 'generated',
    };
  }

  #internalCandidate(
    value: string | undefined,
  ): { session: SelectedSession; identity: SessionIdentity; resolvedBy: LogicalSessionSource } | undefined {
    if (value === undefined) return undefined;
    const normalized = normalizeSessionValue(value);
    if (normalized === undefined) return undefined;
    const identity: SessionIdentity = { source: 'internal', id: normalized };
    return {
      session: { key: hashSession('internal', normalized), source: 'internal' },
      identity,
      resolvedBy: 'internal',
    };
  }

  #firstCandidate(
    candidates: ProtocolSessionHints['candidates'],
  ): { session: SelectedSession; identity: SessionIdentity; resolvedBy: LogicalSessionSource } | undefined {
    const candidate = selectSessionCandidate({ protocol: candidates, headers: new Headers() });
    if (candidate === undefined) return undefined;
    const normalized = normalizeSessionValue(candidate.value);
    if (normalized === undefined) return undefined;
    const identity: SessionIdentity = { source: candidate.source, id: normalized };
    return {
      session: { key: hashSession(candidate.source, normalized), source: candidate.source },
      identity,
      resolvedBy: candidate.source,
    };
  }

  #headerCandidate(
    headers: Headers,
  ): { session: SelectedSession; identity: SessionIdentity; resolvedBy: LogicalSessionSource } | undefined {
    const candidate = selectSessionCandidate({ protocol: [], headers });
    if (candidate === undefined) return undefined;
    const normalized = normalizeSessionValue(candidate.value);
    if (normalized === undefined) return undefined;
    const identity: SessionIdentity = { source: candidate.source, id: normalized };
    return {
      session: { key: hashSession(candidate.source, normalized), source: candidate.source },
      identity,
      resolvedBy: candidate.source,
    };
  }

  #previousResponse(
    responseId: string | undefined,
    now: Date,
    requestId: string,
  ): { session: SelectedSession; identity: SessionIdentity; resolvedBy: LogicalSessionSource } | undefined {
    if (responseId === undefined) return undefined;
    const trimmed = responseId.trim();
    if (trimmed.length === 0) return undefined;

    const persisted = this.#safeResolveResponse(trimmed, now, requestId);
    if (persisted !== undefined) {
      return {
        session: { key: hashSession(persisted.source, persisted.id), source: persisted.source },
        identity: persisted,
        resolvedBy: 'previous-response',
      };
    }

    const normalized = normalizeSessionValue(trimmed);
    if (normalized === undefined) return undefined;
    const entry = this.#responses.get(normalized);
    if (entry === undefined) return undefined;
    const nowMs = now.getTime();
    if (entry.accessedAt + this.#ttlMs <= nowMs) {
      this.#responses.delete(normalized);
      return undefined;
    }
    entry.accessedAt = nowMs;
    const identity: SessionIdentity = { source: 'previous-response', id: entry.sessionKey };
    return {
      session: { key: entry.sessionKey, source: 'previous-response' },
      identity,
      resolvedBy: 'previous-response',
    };
  }

  #safeResolveResponse(responseId: string, now: Date, requestId: string): SessionIdentity | undefined {
    try {
      return this.#repository.resolveResponse(responseId, now);
    } catch (error) {
      this.#emitPersistenceFailure('resolve_response', requestId, error);
      return undefined;
    }
  }

  #safeFindAffinity(
    identity: SessionIdentity,
    requestedModelId: string,
    now: Date,
    requestId: string,
  ): SessionAffinityObservation | undefined {
    try {
      return this.#repository.findAffinity(identity, requestedModelId, now);
    } catch (error) {
      this.#emitPersistenceFailure('find_affinity', requestId, error);
      return undefined;
    }
  }

  #evictOldest(): void {
    let oldestId: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [responseId, entry] of this.#responses) {
      if (entry.accessedAt < oldestAccess) {
        oldestId = responseId;
        oldestAccess = entry.accessedAt;
      }
    }
    if (oldestId !== undefined) this.#responses.delete(oldestId);
  }

  #emitPersistenceFailure(
    operation: 'resolve_response' | 'find_affinity',
    requestId: string | undefined,
    error: unknown,
  ): void {
    if (this.#logger === undefined) return;
    logServerEvent(this.#logger, {
      event: 'trace.persistence_failed',
      operation,
      ...(requestId === undefined ? {} : { requestId }),
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
}

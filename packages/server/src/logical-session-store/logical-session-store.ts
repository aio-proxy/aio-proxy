import { hashSession, normalizeSessionValue, type ProtocolSessionHints, selectSessionCandidate } from '@aio-proxy/core';
import type { LogicalRequestContext, LogicalSessionSource } from '@aio-proxy/plugin-sdk';

import { logServerEvent, type ServerLogSink } from '../server-log';
import { ResponseOwnershipCache } from './response-cache';

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

export type SessionResponseOwner = {
  readonly identity: SessionIdentity;
  readonly providerId: string;
};

export type SessionResponseResolution =
  | { readonly status: 'owned'; readonly owner: SessionResponseOwner }
  | { readonly status: 'ambiguous' };

export type SessionAffinityObservation = {
  readonly providerId: string;
  readonly revision: number;
  readonly active: boolean;
};

type LogicalResponseState =
  | { readonly responseStatus: 'none'; readonly responseOwner?: never }
  | { readonly responseStatus: 'owned'; readonly responseOwner: SessionResponseOwner }
  | { readonly responseStatus: 'ambiguous'; readonly responseOwner?: never };

export type LogicalSessionResolution = LogicalRequestContext &
  LogicalResponseState & {
    readonly context: LogicalRequestContext;
    readonly identity: SessionIdentity;
    readonly resolvedBy: LogicalSessionSource;
    readonly affinity?: SessionAffinityObservation;
  };

export type LogicalSessionRepository = {
  readonly resolveResponse: (responseId: string, now: Date) => SessionResponseResolution | undefined;
  readonly markResponseAmbiguous?: (responseId: string, now: Date) => void;
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

export type LogicalSessionStoreOptions = {
  readonly repository?: LogicalSessionRepository;
  readonly logger?: ServerLogSink;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
};

type SelectedSession = LogicalRequestContext['session'];
type SelectedResolution = {
  readonly session: SelectedSession;
  readonly identity: SessionIdentity;
  readonly resolvedBy: LogicalSessionSource;
};

type PreviousResponseResolution =
  | { readonly status: 'owned'; readonly owner: SessionResponseOwner; readonly selected: SelectedResolution }
  | { readonly status: 'ambiguous' };

export class LogicalSessionStore {
  readonly #repository: LogicalSessionRepository;
  readonly #logger: ServerLogSink | undefined;
  readonly #now: () => Date;
  readonly #responses: ResponseOwnershipCache;

  constructor(options: LogicalSessionStoreOptions = {}) {
    this.#repository = options.repository ?? NOOP_REPOSITORY;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#responses = new ResponseOwnershipCache(
      options.ttlMs ?? DEFAULT_TTL_MS,
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    );
  }

  begin(input: LogicalSessionInput): LogicalSessionResolution {
    const now = this.#now();
    const requestId = input.requestId ?? crypto.randomUUID();
    const requestedModelId = input.requestedModelId ?? 'unknown';
    const response = this.#previousResponse(input.hints.previousResponseId, now, requestId);
    const selected = this.#select(input, response?.status === 'owned' ? response.selected : undefined);
    const context: LogicalRequestContext = { requestId, session: selected.session };

    const affinity =
      response?.status === 'ambiguous' || selected.resolvedBy === 'generated'
        ? undefined
        : this.#safeFindAffinity(selected.identity, requestedModelId, now, requestId);

    const resolution = {
      ...context,
      context,
      identity: selected.identity,
      resolvedBy: selected.resolvedBy,
      ...(affinity === undefined ? {} : { affinity }),
    };
    if (response?.status === 'owned') {
      return { ...resolution, responseStatus: 'owned', responseOwner: response.owner };
    }
    if (response?.status === 'ambiguous') return { ...resolution, responseStatus: 'ambiguous' };
    return { ...resolution, responseStatus: 'none' };
  }

  commitResponse(
    responseId: string,
    sessionKey: `sha256:${string}`,
    identity: SessionIdentity,
    providerId: string,
  ): void {
    this.#responses.commit(responseId, sessionKey, identity, providerId, this.#now().getTime());
  }

  reconcilePersistedResponse(responseId: string): void {
    const trimmed = responseId.trim();
    if (trimmed.length === 0) return;
    const now = this.#now();
    const persisted = this.#safeResolveResponse(trimmed, now, undefined);
    this.#reconcileResponse(trimmed, persisted, now, undefined);
  }

  #select(input: LogicalSessionInput, previous: SelectedResolution | undefined): SelectedResolution {
    const internal = this.#internalCandidate(input.internalSessionId);
    if (internal !== undefined) return internal;

    const candidate = this.#firstCandidate(input.hints.candidates);
    if (candidate !== undefined) return candidate;

    const header = this.#headerCandidate(input.headers);
    if (header !== undefined) return header;

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
  ): PreviousResponseResolution | undefined {
    if (responseId === undefined) return undefined;
    const trimmed = responseId.trim();
    if (trimmed.length === 0) return undefined;

    const persisted = this.#safeResolveResponse(trimmed, now, requestId);
    const response = this.#reconcileResponse(trimmed, persisted, now, requestId);
    if (response === undefined) return undefined;
    if (response.status === 'ambiguous') return response;
    const { owner } = response;
    return {
      status: 'owned',
      owner,
      selected: {
        session: {
          key: 'sessionKey' in response ? response.sessionKey : hashSession(owner.identity.source, owner.identity.id),
          source: owner.identity.source,
        },
        identity: owner.identity,
        resolvedBy: 'previous-response',
      },
    };
  }

  #safeResolveResponse(
    responseId: string,
    now: Date,
    requestId: string | undefined,
  ): SessionResponseResolution | undefined {
    try {
      return this.#repository.resolveResponse(responseId, now);
    } catch (error) {
      this.#emitPersistenceFailure('resolve_response', requestId, error);
      return undefined;
    }
  }

  #reconcileResponse(
    responseId: string,
    persisted: SessionResponseResolution | undefined,
    now: Date,
    requestId: string | undefined,
  ) {
    const response = this.#responses.reconcile(responseId, persisted, now.getTime());
    if (
      response?.status === 'ambiguous' &&
      persisted?.status !== 'ambiguous' &&
      'repair' in response &&
      response.repair
    ) {
      try {
        this.#repository.markResponseAmbiguous?.(responseId, now);
      } catch (error) {
        this.#emitPersistenceFailure('mark_response_ambiguous', requestId, error);
      }
    }
    return response;
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

  #emitPersistenceFailure(
    operation: 'resolve_response' | 'mark_response_ambiguous' | 'find_affinity',
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

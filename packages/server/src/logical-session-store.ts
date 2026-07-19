import { hashSession, normalizeSessionValue, type ProtocolSessionHints, selectSessionCandidate } from "@aio-proxy/core";
import type { LogicalRequestContext, LogicalSessionSource } from "@aio-proxy/plugin-sdk";

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_ENTRIES = 10_240;

export type LogicalSessionStoreOptions = {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
};

export type LogicalSessionInput = {
  readonly hints: ProtocolSessionHints;
  readonly headers: Headers;
  readonly internalSessionId?: string;
};

type SelectedSession = LogicalRequestContext["session"];
type ResponseSession = { readonly sessionKey: `sha256:${string}`; accessedAt: number };

export class LogicalSessionStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #responses = new Map<string, ResponseSession>();

  constructor(options: LogicalSessionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  begin(input: LogicalSessionInput): LogicalRequestContext {
    const selected =
      this.#internalCandidate(input.internalSessionId) ??
      this.#firstCandidate(input.hints.candidates) ??
      this.#headerCandidate(input.headers) ??
      this.#previousResponse(input.hints.previousResponseId) ??
      this.#generatedCandidate();
    return { requestId: crypto.randomUUID(), session: selected };
  }

  commitResponse(responseId: string, sessionKey: `sha256:${string}`): void {
    const normalized = normalizeSessionValue(responseId);
    if (normalized === undefined) return;
    this.#responses.set(normalized, { sessionKey, accessedAt: this.#now() });
    while (this.#responses.size > this.#maxEntries) this.#evictOldest();
  }

  #internalCandidate(value: string | undefined): SelectedSession | undefined {
    return value === undefined ? undefined : selectedValue("internal", value);
  }

  #firstCandidate(candidates: ProtocolSessionHints["candidates"]): SelectedSession | undefined {
    const candidate = selectSessionCandidate({ protocol: candidates, headers: new Headers() });
    return candidate === undefined ? undefined : selectedValue(candidate.source, candidate.value);
  }

  #headerCandidate(headers: Headers): SelectedSession | undefined {
    const candidate = selectSessionCandidate({ protocol: [], headers });
    return candidate === undefined ? undefined : selectedValue(candidate.source, candidate.value);
  }

  #previousResponse(responseId: string | undefined): SelectedSession | undefined {
    if (responseId === undefined) return undefined;
    const normalized = normalizeSessionValue(responseId);
    if (normalized === undefined) return undefined;
    const entry = this.#responses.get(normalized);
    if (entry === undefined) return undefined;
    const now = this.#now();
    if (entry.accessedAt + this.#ttlMs <= now) {
      this.#responses.delete(normalized);
      return undefined;
    }
    entry.accessedAt = now;
    return { key: entry.sessionKey, source: "previous-response" };
  }

  #generatedCandidate(): SelectedSession {
    return { key: hashSession("generated", crypto.randomUUID()), source: "generated" };
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
}

function selectedValue(source: LogicalSessionSource, value: string): SelectedSession | undefined {
  const normalized = normalizeSessionValue(value);
  return normalized === undefined ? undefined : { key: hashSession(source, normalized), source };
}

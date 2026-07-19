import { RequestMappingIndex } from "./replay-cache/request-mapping-index";

const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_ENTRIES = 10_240;

export type ReplayKey = `${string}\u0000sha256:${string}`;
export type ReplayScope = { readonly key: ReplayKey; readonly requestId: string; readonly generation: number };
export type ReplayPart =
  | {
      readonly type: "thought-signature";
      readonly contentIndex: number;
      readonly partIndex: number;
      readonly signature: string;
    }
  | {
      readonly type: "function-call";
      readonly contentIndex: number;
      readonly partIndex: number;
      readonly call: unknown;
      readonly signature?: string;
    };
export type ReasoningReplay = { readonly parts: readonly ReplayPart[] };

type ReplayEntry = {
  committedGeneration: number;
  expiresAt: number;
  lastAccessAt: number;
  replay?: ReasoningReplay;
};

type RequestGenerationEntry = {
  readonly generation: number;
  readonly replayKey: ReplayKey;
  expiresAt: number;
  lastAccessAt: number;
};

export type ReasoningReplayCacheOptions = {
  readonly maxEntries?: number;
  readonly maxRequestMappings?: number;
  readonly now?: () => number;
  readonly requestTtlMs?: number;
  readonly ttlMs?: number;
};

export class ReasoningReplayCache {
  readonly #entries = new Map<ReplayKey, ReplayEntry>();
  #generation = 0;
  readonly #maxEntries: number;
  readonly #maxRequestMappings: number;
  #nextEntryExpiry = Number.POSITIVE_INFINITY;
  #nextRequestMappingExpiry = Number.POSITIVE_INFINITY;
  readonly #now: () => number;
  readonly #requests = new RequestMappingIndex<RequestGenerationEntry>();
  readonly #requestTtlMs: number;
  readonly #ttlMs: number;

  constructor(options: ReasoningReplayCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxRequestMappings = options.maxRequestMappings ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
    this.#requestTtlMs = options.requestTtlMs ?? DEFAULT_TTL_MS;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  begin(modelId: string, sessionKey: `sha256:${string}`, logicalRequestId: string): ReplayScope {
    const now = this.#now();
    this.#removeExpiredEntries(now);
    this.#removeExpiredRequestMappings(now);
    const key = `${modelId}\u0000${sessionKey}` as ReplayKey;
    let entry = this.#entries.get(key);
    const created = entry === undefined;
    if (entry === undefined) {
      entry = {
        committedGeneration: 0,
        expiresAt: now + this.#ttlMs,
        lastAccessAt: now,
      };
      this.#entries.set(key, entry);
    }
    const requestKey = requestMappingKey(key, logicalRequestId);
    let request = this.#requests.get(requestKey);
    if (request === undefined) {
      request = {
        expiresAt: now + this.#requestTtlMs,
        generation: ++this.#generation,
        lastAccessAt: now,
        replayKey: key,
      };
      this.#requests.set(requestKey, request);
      this.#nextRequestMappingExpiry = Math.min(this.#nextRequestMappingExpiry, request.expiresAt);
      if (created) entry.committedGeneration = request.generation;
    } else {
      this.#touchRequestMapping(request, now);
    }
    this.#touch(entry, now);
    this.#evictEntryOverflow();
    this.#evictRequestMappingOverflow();
    return { key, requestId: logicalRequestId, generation: request.generation };
  }

  read(key: ReplayKey): ReasoningReplay | undefined {
    const now = this.#now();
    this.#removeExpiredEntries(now);
    this.#removeExpiredRequestMappings(now);
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#touch(entry, now);
    return entry.replay;
  }

  commit(scope: ReplayScope, replay: ReasoningReplay): boolean {
    const entry = this.#activeEntry(scope.key);
    if (entry === undefined || scope.generation < entry.committedGeneration) return false;
    entry.committedGeneration = scope.generation;
    entry.replay = { parts: [...replay.parts] };
    this.#touch(entry, this.#now());
    return true;
  }

  clear(scope: ReplayScope): boolean {
    const entry = this.#activeEntry(scope.key);
    if (entry === undefined || scope.generation < entry.committedGeneration) return false;
    entry.committedGeneration = scope.generation;
    delete entry.replay;
    this.#touch(entry, this.#now());
    return true;
  }

  #activeEntry(key: ReplayKey): ReplayEntry | undefined {
    const now = this.#now();
    this.#removeExpiredEntries(now);
    this.#removeExpiredRequestMappings(now);
    return this.#entries.get(key);
  }

  #touch(entry: ReplayEntry, now: number): void {
    entry.lastAccessAt = now;
    entry.expiresAt = now + this.#ttlMs;
    this.#nextEntryExpiry = Math.min(this.#nextEntryExpiry, entry.expiresAt);
  }

  #touchRequestMapping(request: RequestGenerationEntry, now: number): void {
    request.lastAccessAt = now;
    request.expiresAt = now + this.#requestTtlMs;
    this.#nextRequestMappingExpiry = Math.min(this.#nextRequestMappingExpiry, request.expiresAt);
  }

  #removeExpiredEntries(now: number): void {
    if (now < this.#nextEntryExpiry) return;
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#removeEntry(key);
      else nextExpiry = Math.min(nextExpiry, entry.expiresAt);
    }
    this.#nextEntryExpiry = nextExpiry;
  }

  #removeExpiredRequestMappings(now: number): void {
    if (now < this.#nextRequestMappingExpiry) return;
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, request] of this.#requests) {
      if (request.expiresAt <= now) this.#requests.delete(key);
      else nextExpiry = Math.min(nextExpiry, request.expiresAt);
    }
    this.#nextRequestMappingExpiry = nextExpiry;
  }

  #evictEntryOverflow(): void {
    while (this.#entries.size > this.#maxEntries) {
      let oldestKey: ReplayKey | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.#entries) {
        if (entry.lastAccessAt < oldestAccess) {
          oldestAccess = entry.lastAccessAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      this.#removeEntry(oldestKey);
    }
  }

  #evictRequestMappingOverflow(): void {
    while (this.#requests.size > this.#maxRequestMappings) {
      let oldestKey: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, request] of this.#requests) {
        if (request.lastAccessAt < oldestAccess) {
          oldestAccess = request.lastAccessAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      this.#requests.delete(oldestKey);
    }
  }

  #removeEntry(key: ReplayKey): void {
    this.#entries.delete(key);
    this.#requests.deleteReplay(key);
  }
}

function requestMappingKey(key: ReplayKey, logicalRequestId: string): string {
  return `${key}\u0000${logicalRequestId}`;
}

export const antigravityReplayCache = new ReasoningReplayCache();

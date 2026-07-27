import { hashSession } from '@aio-proxy/core';

import type { SessionIdentity, SessionResponseOwner, SessionResponseResolution } from './logical-session-store';

type ResponseSession =
  | {
      readonly status: 'owned';
      readonly sessionKey: `sha256:${string}`;
      readonly identity: SessionIdentity;
      readonly providerId: string;
      confirmed: boolean;
      accessedAt: number;
    }
  | { readonly status: 'ambiguous' };

export type CachedResponseResolution =
  | { readonly status: 'owned'; readonly sessionKey: `sha256:${string}`; readonly owner: SessionResponseOwner }
  | { readonly status: 'ambiguous'; readonly repair: boolean };

export class ResponseOwnershipCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #responses = new Map<`sha256:${string}`, ResponseSession>();
  #degraded = false;

  constructor(ttlMs: number, maxEntries: number) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  commit(
    responseId: string,
    sessionKey: `sha256:${string}`,
    identity: SessionIdentity,
    providerId: string,
    now: number,
  ): void {
    const responseKey = responseHash(responseId);
    if (responseKey === undefined) return;
    if (this.#degraded) return;
    const existing = this.#responses.get(responseKey);
    if (existing?.status === 'ambiguous') return;
    if (existing !== undefined) {
      const sameOwner =
        existing.identity.source === identity.source &&
        existing.identity.id === identity.id &&
        existing.providerId === providerId;
      if (!sameOwner) {
        this.#responses.set(responseKey, { status: 'ambiguous' });
        return;
      }
      existing.accessedAt = now;
      return;
    }
    this.#responses.set(responseKey, {
      status: 'owned',
      sessionKey,
      identity,
      providerId,
      confirmed: false,
      accessedAt: now,
    });
    while (this.#responses.size > this.#maxEntries && this.#evictOldestOwned()) {}
    // ponytail: global fail-closed mode bounds memory during persistence loss;
    // replace it with a bounded durable deny-set if degraded availability matters.
    if (this.#responses.size > this.#maxEntries) this.#enterDegraded();
  }

  resolve(
    responseId: string,
    now: number,
    persisted: SessionResponseResolution | undefined,
  ): CachedResponseResolution | undefined {
    const responseKey = responseHash(responseId);
    if (responseKey === undefined) return undefined;
    if (this.#degraded) return { status: 'ambiguous', repair: false };
    const entry = this.#responses.get(responseKey);
    if (entry === undefined) return undefined;
    // Ambiguity is monotonic and intentionally exempt from TTL expiry.
    if (entry.status === 'ambiguous') return { status: 'ambiguous', repair: true };
    if (entry.accessedAt + this.#ttlMs <= now) {
      if (entry.confirmed) {
        this.#responses.delete(responseKey);
        return undefined;
      }
      if (persisted?.status === 'owned' && ownedEntryMatches(entry, persisted.owner)) {
        entry.confirmed = true;
      } else if (persisted === undefined) {
        this.#enterDegraded();
        return { status: 'ambiguous', repair: false };
      }
    }
    if (entry.confirmed) entry.accessedAt = now;
    return {
      status: 'owned',
      sessionKey: entry.sessionKey,
      owner: { identity: entry.identity, providerId: entry.providerId },
    };
  }

  reconcile(
    responseId: string,
    persisted: SessionResponseResolution | undefined,
    now: number,
  ): SessionResponseResolution | CachedResponseResolution | undefined {
    const cached = this.resolve(responseId, now, persisted);
    const response = reconcileResponses(persisted, cached);
    if (response?.status === 'ambiguous') {
      if (persisted?.status === 'ambiguous' || ('repair' in response && response.repair)) {
        this.#markAmbiguous(responseId);
      }
      return response;
    }
    if (persisted?.status === 'owned' && cached?.status === 'owned') this.#confirm(responseId, now);
    return response;
  }

  #markAmbiguous(responseId: string): void {
    if (this.#degraded) return;
    const responseKey = responseHash(responseId);
    if (responseKey === undefined) return;
    this.#responses.set(responseKey, { status: 'ambiguous' });
  }

  #confirm(responseId: string, now: number): void {
    const responseKey = responseHash(responseId);
    if (responseKey === undefined) return;
    const entry = this.#responses.get(responseKey);
    if (entry === undefined || entry.status === 'ambiguous') return;
    entry.confirmed = true;
    entry.accessedAt = now;
  }

  #evictOldestOwned(): boolean {
    let oldestKey: `sha256:${string}` | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [responseKey, entry] of this.#responses) {
      if (entry.status === 'owned' && entry.confirmed && entry.accessedAt < oldestAccess) {
        oldestKey = responseKey;
        oldestAccess = entry.accessedAt;
      }
    }
    if (oldestKey === undefined) return false;
    this.#responses.delete(oldestKey);
    return true;
  }

  #enterDegraded(): void {
    this.#responses.clear();
    this.#degraded = true;
  }
}

function responseHash(responseId: string): `sha256:${string}` | undefined {
  const trimmed = responseId.trim();
  return trimmed.length === 0 ? undefined : hashSession('response-id', trimmed);
}

function reconcileResponses(
  persisted: SessionResponseResolution | undefined,
  cached: CachedResponseResolution | undefined,
): SessionResponseResolution | CachedResponseResolution | undefined {
  if (cached?.status === 'ambiguous') return cached;
  if (persisted?.status === 'ambiguous') return persisted;
  if (persisted === undefined) return cached;
  if (cached === undefined) return persisted;
  return responseOwnersEqual(persisted.owner, cached.owner) ? cached : { status: 'ambiguous', repair: true };
}

function ownedEntryMatches(entry: Extract<ResponseSession, { readonly status: 'owned' }>, owner: SessionResponseOwner) {
  return responseOwnersEqual({ identity: entry.identity, providerId: entry.providerId }, owner);
}

function responseOwnersEqual(first: SessionResponseOwner, second: SessionResponseOwner): boolean {
  return (
    first.providerId === second.providerId &&
    first.identity.source === second.identity.source &&
    first.identity.id === second.identity.id
  );
}

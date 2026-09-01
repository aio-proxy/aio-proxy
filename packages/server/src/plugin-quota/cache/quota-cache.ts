import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { LRUCache } from 'lru-cache';

import { OAuthQuotaCapabilityUnavailableError } from '../errors';
import type { OAuthQuotaReader } from '../read';

const COOLDOWN_MS = 5 * 60_000;
const MAX_ENTRIES = 256;
const READ_TIMEOUT_MS = 15_000;

export type OAuthQuotaCacheEntry = {
  readonly snapshot: OAuthQuotaSnapshot;
  readonly sampledAt: number;
  readonly stale: boolean;
  readonly error?: string;
};

export type OAuthQuotaCache = {
  readonly read: (providerId: string, refresh?: boolean) => Promise<OAuthQuotaCacheEntry>;
  readonly warm: (providerId: string) => void;
};

/**
 * In-memory only, lost on restart: a quota snapshot is a cheap re-read and persisting it would
 * outlive the credential it describes.
 *
 * The cooldown is set even when a read throws, so a provider whose upstream is down is retried at
 * the same 5-minute rhythm instead of on every card render. `refresh: true` (the modal's manual
 * button) is the documented escape hatch.
 *
 * Reads share one in-flight promise per provider and one 15s timeout, deliberately detached from
 * any caller's signal: a card unmounting mid-load must not abort the read the modal is awaiting,
 * and a warm started by the pipeline must not leave a concurrent card stranded behind the cooldown
 * it just set.
 */
export function createOAuthQuotaCache(reader: OAuthQuotaReader): OAuthQuotaCache {
  const entries = new LRUCache<string, OAuthQuotaCacheEntry>({ max: MAX_ENTRIES });
  const failures = new LRUCache<string, Error>({ max: MAX_ENTRIES, ttl: COOLDOWN_MS, ttlAutopurge: true });
  const cooldown = new LRUCache<string, true>({ max: MAX_ENTRIES, ttl: COOLDOWN_MS, ttlAutopurge: true });
  const inFlight = new Map<string, Promise<OAuthQuotaCacheEntry>>();
  // A plugin without a quota capability will not grow one at runtime, and every retry re-prepares
  // the OAuth account (credentials, diagnostics) for nothing. Skip it for the process lifetime.
  const unsupported = new Set<string>();

  const load = async (providerId: string): Promise<OAuthQuotaCacheEntry> => {
    const previous = entries.get(providerId);
    cooldown.set(providerId, true);
    try {
      const entry: OAuthQuotaCacheEntry = {
        snapshot: await reader.read(providerId, AbortSignal.timeout(READ_TIMEOUT_MS)),
        sampledAt: Date.now(),
        stale: false,
      };
      entries.set(providerId, entry);
      failures.delete(providerId);
      return entry;
    } catch (error) {
      if (error instanceof OAuthQuotaCapabilityUnavailableError) unsupported.add(providerId);
      if (previous === undefined) {
        failures.set(providerId, error instanceof Error ? error : new Error('QUOTA_READ_FAILED'));
        throw error;
      }
      // Replaces the entry so the next cooldown hit still reports the failure instead of silently
      // presenting the old snapshot as fresh.
      const stale: OAuthQuotaCacheEntry = {
        snapshot: previous.snapshot,
        sampledAt: previous.sampledAt,
        stale: true,
        error: error instanceof Error ? error.message : 'QUOTA_READ_FAILED',
      };
      entries.set(providerId, stale);
      return stale;
    }
  };

  const start = (providerId: string): Promise<OAuthQuotaCacheEntry> => {
    const pending = inFlight.get(providerId);
    if (pending !== undefined) return pending;
    const promise = load(providerId).finally(() => {
      if (inFlight.get(providerId) === promise) inFlight.delete(providerId);
    });
    inFlight.set(providerId, promise);
    return promise;
  };

  const read = async (providerId: string, refresh = false): Promise<OAuthQuotaCacheEntry> => {
    if (unsupported.has(providerId)) throw new OAuthQuotaCapabilityUnavailableError();
    if (!refresh && cooldown.has(providerId)) {
      const cached = entries.get(providerId);
      if (cached !== undefined) return cached;
      const failure = failures.get(providerId);
      if (failure !== undefined) throw failure;
    }
    return await start(providerId);
  };

  return {
    read,
    warm: (providerId) => {
      if (unsupported.has(providerId) || cooldown.has(providerId)) return;
      void start(providerId).catch(() => {});
    },
  };
}

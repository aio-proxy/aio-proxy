import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { LRUCache } from 'lru-cache';

import type { OAuthQuotaReader } from '../read';

const COOLDOWN_MS = 5 * 60_000;
const MAX_ENTRIES = 256;
const WARM_TIMEOUT_MS = 15_000;

export type OAuthQuotaCacheEntry = {
  readonly snapshot: OAuthQuotaSnapshot;
  readonly sampledAt: number;
  readonly stale: boolean;
  readonly error?: string;
};

export type OAuthQuotaCache = {
  readonly read: (providerId: string, signal: AbortSignal, refresh?: boolean) => Promise<OAuthQuotaCacheEntry>;
  readonly warm: (providerId: string) => void;
};

type Sample = { readonly snapshot: OAuthQuotaSnapshot; readonly sampledAt: number };

/**
 * In-memory only, lost on restart: a quota snapshot is a cheap re-read and persisting it would
 * outlive the credential it describes.
 *
 * The cooldown is set even when a read throws, so a provider whose upstream is down is retried at
 * the same 5-minute rhythm instead of on every card render. `refresh: true` (the modal's manual
 * button) is the documented escape hatch.
 */
export function createOAuthQuotaCache(reader: OAuthQuotaReader): OAuthQuotaCache {
  const samples = new LRUCache<string, Sample>({ max: MAX_ENTRIES });
  const cooldown = new LRUCache<string, true>({ max: MAX_ENTRIES, ttl: COOLDOWN_MS, ttlAutopurge: true });

  const read = async (providerId: string, signal: AbortSignal, refresh = false): Promise<OAuthQuotaCacheEntry> => {
    const cached = samples.get(providerId);
    if (!refresh && cached !== undefined && cooldown.has(providerId)) {
      return { snapshot: cached.snapshot, sampledAt: cached.sampledAt, stale: false };
    }
    cooldown.set(providerId, true);
    try {
      const snapshot = await reader.read(providerId, signal);
      const sample: Sample = { snapshot, sampledAt: Date.now() };
      samples.set(providerId, sample);
      return { snapshot: sample.snapshot, sampledAt: sample.sampledAt, stale: false };
    } catch (error) {
      if (cached === undefined) throw error;
      return {
        snapshot: cached.snapshot,
        sampledAt: cached.sampledAt,
        stale: true,
        error: error instanceof Error ? error.message : 'QUOTA_READ_FAILED',
      };
    }
  };

  return {
    read,
    // ponytail: no in-flight dedupe — the cooldown plus the dashboard's 30s staleTime already
    // collapse bursts; add one if a provider ever shows concurrent upstream reads.
    warm: (providerId) => {
      if (cooldown.has(providerId)) return;
      void read(providerId, AbortSignal.timeout(WARM_TIMEOUT_MS)).catch(() => {});
    },
  };
}

import { LRUCache } from 'lru-cache';

// Cross-request, in-memory cooldown for (provider, model) pairs that returned a
// 429 with a Retry-After. Per-item TTL + ttlAutopurge reclaim expired entries
// (including orphans from a config reload that dropped a provider) without a
// manual sweep; `max` bounds memory. Advisory only: concurrent reads before the
// first write, and eviction past `max`, may still allow an extra upstream call.
const MAX_COOLDOWN_ENTRIES = 1_024;

export class ProviderCooldownStore {
  readonly #cache = new LRUCache<string, true>({ max: MAX_COOLDOWN_ENTRIES, ttlAutopurge: true });

  #key(providerId: string, model: string): string {
    return JSON.stringify([providerId, model]);
  }

  cool(providerId: string, model: string, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.#cache.set(this.#key(providerId, model), true, { ttl: ttlMs });
  }

  remainingMs(providerId: string, model: string): number {
    const key = this.#key(providerId, model);
    return this.#cache.has(key) ? this.#cache.getRemainingTTL(key) : 0;
  }
}

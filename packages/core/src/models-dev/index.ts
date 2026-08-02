import { Models, type Model, type ProviderMap, type RequestOptions } from '@opencode-ai/models';
import { LRUCache } from 'lru-cache';

import { fileCacheStorage } from '../cache';
import { resolveModel } from './resolve';

export { findModelPrice } from './price';

const PROVIDERS_CACHE_KEY = 'models-dev-providers';
const PROVIDERS_CACHE_TTL = 1_000 * 60 * 60 * 6;
// Custom model ids absent from models.dev never populate the resolved-model LRU,
// so a hot-path lookup would re-read and JSON-parse the whole cached provider
// catalog from disk on every request. A short negative TTL absorbs that burst of
// repeated I/O while still letting a later catalog warm (e.g. via /v1/models)
// resolve the id once the sentinel expires.
const NEGATIVE_CACHE_TTL = 1_000 * 30;
// The resolved-model LRU only holds hits and is capped at 16 entries, so a
// deployment with more than 16 distinct configured models thrashes it: every
// LRU miss re-reads and JSON-parses the whole provider catalog from disk. This
// short-lived memory cache holds the parsed provider map so resolveModel runs
// against memory regardless of per-model LRU eviction. The TTL keeps it well
// under the file cache's 6h window so a catalog refresh still propagates.
const PROVIDER_MAP_MEMORY_TTL = 1_000 * 30;

const client = Models.make();
const cache = new LRUCache<string, Model>({
  max: 16,
  ttl: PROVIDERS_CACHE_TTL,
  updateAgeOnGet: true,
});
// Separate negative cache: getModelsCachedOnly-only. getModels keeps its
// "misses are not cached" contract so a fresh network fetch can still resolve.
const negativeCache = new LRUCache<string, true>({
  max: 64,
  ttl: NEGATIVE_CACHE_TTL,
});
// Single-entry memory cache for the parsed provider map. Keyed by the file
// cache key so clearModelsCache can invalidate it deterministically in tests.
const providerMapMemoryCache = new LRUCache<string, ProviderMap>({
  max: 1,
  ttl: PROVIDER_MAP_MEMORY_TTL,
});

// The resolved-model cache is a module singleton keyed by model id, holding
// hits only. Tests that seed different provider maps under the same id must
// clear it between cases, or a prior case's cached hit leaks into the next.
export function clearModelsCache(): void {
  cache.clear();
  negativeCache.clear();
  providerMapMemoryCache.clear();
}

// Read the parsed provider map from the memory cache, falling back to a single
// disk read + JSON parse whose result is memoized for PROVIDER_MAP_MEMORY_TTL.
// Returns undefined only when the file cache is cold.
async function readCachedProviderMap(): Promise<ProviderMap | undefined> {
  const memo = providerMapMemoryCache.get(PROVIDERS_CACHE_KEY);
  if (memo) return memo;
  const providerMap = await fileCacheStorage.getItem<ProviderMap>(PROVIDERS_CACHE_KEY, {
    ttl: PROVIDERS_CACHE_TTL,
  });
  if (providerMap) providerMapMemoryCache.set(PROVIDERS_CACHE_KEY, providerMap);
  return providerMap ?? undefined;
}

export async function getProviders(options?: RequestOptions): Promise<ProviderMap> {
  const cached = await readCachedProviderMap();
  if (cached) return cached;
  const providerMap = await client.providers(options);
  await fileCacheStorage.setItem(PROVIDERS_CACHE_KEY, providerMap);
  providerMapMemoryCache.set(PROVIDERS_CACHE_KEY, providerMap);
  return providerMap;
}
export async function getModels(modelIds: string[], options?: RequestOptions) {
  const result: Record<string, Model | undefined> = {};
  let providerMap: ProviderMap | undefined;
  for (const modelId of modelIds) {
    const cached = cache.get(modelId);
    if (cached !== undefined) {
      result[modelId] = cached;
      continue;
    }
    if (!providerMap) providerMap = await getProviders(options);
    const model = resolveModel(providerMap, modelId);
    result[modelId] = model;
    // Cache hits only: a miss stays uncached so a later provider-map refresh
    // can resolve it without a stale negative entry blocking the lookup.
    if (model !== undefined) cache.set(modelId, model);
  }
  return result;
}

// Resolve models using ONLY already-cached data (the resolved-model LRU and the
// file-cached provider map). Never triggers a network catalog fetch, so it is
// safe on the request hot path: a cold or slow models.dev yields undefined
// rather than blocking. Any warm fetch happens elsewhere (e.g. /v1/models).
export async function getModelsCachedOnly(modelIds: string[]): Promise<Record<string, Model | undefined>> {
  const result: Record<string, Model | undefined> = {};
  let providerMap: ProviderMap | undefined | null;
  for (const modelId of modelIds) {
    const cached = cache.get(modelId);
    if (cached !== undefined) {
      result[modelId] = cached;
      continue;
    }
    // A recent unresolved lookup short-circuits before touching disk again.
    if (negativeCache.has(modelId)) {
      result[modelId] = undefined;
      continue;
    }
    if (providerMap === undefined) {
      providerMap = (await readCachedProviderMap()) ?? null;
    }
    if (!providerMap) {
      // Cold catalog: leave the negative cache untouched so the very next
      // request retries once the file cache is warm rather than waiting out
      // the sentinel TTL.
      result[modelId] = undefined;
      continue;
    }
    const model = resolveModel(providerMap, modelId);
    result[modelId] = model;
    if (model !== undefined) cache.set(modelId, model);
    else negativeCache.set(modelId, true);
  }
  return result;
}

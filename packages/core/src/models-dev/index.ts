import { Models, type Model, type ProviderMap, type RequestOptions } from '@opencode-ai/models';
import { LRUCache } from 'lru-cache';

import { fileCacheStorage } from '../cache';
import { resolveModel } from './resolve';

export { findModelPrice } from './price';

const PROVIDERS_CACHE_KEY = 'models-dev-providers';
const PROVIDERS_CACHE_TTL = 1_000 * 60 * 60 * 6;

const client = Models.make();
const cache = new LRUCache<string, Model>({
  max: 16,
  ttl: PROVIDERS_CACHE_TTL,
  updateAgeOnGet: true,
});

// The resolved-model cache is a module singleton keyed by model id, holding
// hits only. Tests that seed different provider maps under the same id must
// clear it between cases, or a prior case's cached hit leaks into the next.
export function clearModelsCache(): void {
  cache.clear();
}

export async function getProviders(options?: RequestOptions): Promise<ProviderMap> {
  const cached = await fileCacheStorage.getItem<ProviderMap>(PROVIDERS_CACHE_KEY, {
    ttl: PROVIDERS_CACHE_TTL,
  });
  if (cached) return cached;
  const providerMap = await client.providers(options);
  await fileCacheStorage.setItem(PROVIDERS_CACHE_KEY, providerMap);
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
    if (providerMap === undefined) {
      providerMap = await fileCacheStorage.getItem<ProviderMap>(PROVIDERS_CACHE_KEY, { ttl: PROVIDERS_CACHE_TTL });
    }
    if (!providerMap) {
      result[modelId] = undefined;
      continue;
    }
    const model = resolveModel(providerMap, modelId);
    result[modelId] = model;
    if (model !== undefined) cache.set(modelId, model);
  }
  return result;
}

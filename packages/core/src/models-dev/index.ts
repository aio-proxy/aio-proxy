import { Models, type Model, type ProviderMap, type RequestOptions } from '@opencode-ai/models';
import { LRUCache } from 'lru-cache';

import { fileCacheStorage } from '../cache';

export { findModelPrice } from './price';

const PROVIDERS_CACHE_KEY = 'models-dev-providers';
const PROVIDERS_CACHE_TTL = 1_000 * 60 * 60 * 6;

// A model id whose prefix pins it to a single models.dev provider.
const PREFIX_PROVIDERS: Record<string, string> = {
  'gpt-': 'openai',
  'claude-': 'anthropic',
  'gemini-': 'google',
};

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

function resolveModel(providerMap: ProviderMap, modelId: string): Model | undefined {
  // Explicit provider/model id wins. Split on the first slash only, so a
  // multi-segment id like `openrouter/vendor/mistral-large` keeps its full
  // `vendor/mistral-large` model id instead of being truncated to `vendor`.
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const providerId = modelId.slice(0, slash);
    const providerModelId = modelId.slice(slash + 1);
    const hit = providerMap[providerId]?.models[providerModelId];
    if (hit) return hit;
  }
  // A known prefix pins the provider.
  for (const [prefix, providerId] of Object.entries(PREFIX_PROVIDERS)) {
    if (modelId.startsWith(prefix)) {
      const hit = providerMap[providerId]?.models[modelId];
      if (hit) return hit;
      break;
    }
  }
  // Fall back to OpenRouter, matching the full id or its bare model id.
  return Object.values(providerMap['openrouter']?.models ?? {}).find(
    (m) => m.id === modelId || m.id.split('/', 2)[1] === modelId,
  );
}

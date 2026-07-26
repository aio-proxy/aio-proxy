import { Models, type Model, type ProviderMap, type RequestOptions } from '@opencode-ai/models';
import { map, pipe } from 'es-toolkit/fp';

import { fileCacheStorage } from '../cache';

const PROVIDERS_CACHE_KEY = 'models-dev-providers';
const PROVIDERS_CACHE_TTL = 1_000 * 60 * 60 * 6;

// A model id whose prefix pins it to a single models.dev provider.
const PREFIX_PROVIDERS: Record<string, string> = {
  'gpt-': 'openai',
  'claude-': 'anthropic',
  'gemini-': 'google',
};

const client = Models.make();

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
  const providerMap = await getProviders(options);
  const result = pipe(
    modelIds,
    map((modelId) => [modelId, resolveModel(providerMap, modelId)] as const),
  );
  return Object.fromEntries(result);
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

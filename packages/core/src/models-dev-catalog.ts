import { type Model, Models, type ProviderMap, type RequestOptions } from '@opencode-ai/models';

import type { OpenRouterModelPrice } from './usage-pricing';

export type OpenRouterPriceCatalog = {
  readonly find: (modelId: string) => OpenRouterModelPrice | undefined;
};

export type ModelsDevCatalog = OpenRouterPriceCatalog & {
  readonly displayName: (modelId: string) => string | undefined;
  // The raw models.dev record. Consumers derive whatever provider-specific shape
  // they need (Anthropic capabilities, Codex catalog rows, token limits) at their
  // own boundary; the catalog itself passes the upstream Model through untouched.
  readonly metadata: (modelId: string) => Model | undefined;
};

export type FetchModelsDevProviders = (options?: RequestOptions) => Promise<ProviderMap>;
export type FetchOpenRouterPrices = FetchModelsDevProviders;

type MetadataCatalog = {
  readonly byModelId: ReadonlyMap<string, Model>;
  readonly byOpenRouterBareId: ReadonlyMap<string, Model>;
  readonly byOpenRouterId: ReadonlyMap<string, Model>;
  readonly byProvider: ReadonlyMap<string, ReadonlyMap<string, Model>>;
};

const modelsDev = Models.make();
const modelsDevRequestTimeoutMs = 3_000;
const openRouterProviderId = 'openrouter';
const defaultFetch: FetchModelsDevProviders = (options) => modelsDev.providers(options);

export async function createModelsDevCatalog(
  fetchProviders: FetchModelsDevProviders = defaultFetch,
): Promise<ModelsDevCatalog> {
  const providers = await fetchProviders({ signal: AbortSignal.timeout(modelsDevRequestTimeoutMs) });
  const prices = parsePrices(providers);
  const byId = new Map(prices.map((price) => [price.id, price]));
  const byBareId = uniqueBareEntries(byId);
  const metadata = parseMetadata(providers);

  return {
    displayName(modelId) {
      const model = resolveMetadata(metadata, modelId);
      // A record whose human name equals its id carries no real display name;
      // report undefined so callers fall back to their own alias/slug.
      return model === undefined || model.name === model.id ? undefined : model.name;
    },
    find(modelId) {
      return byId.get(modelId) ?? byBareId.get(modelId);
    },
    metadata(modelId) {
      return resolveMetadata(metadata, modelId);
    },
  };
}

export async function createOpenRouterPriceCatalog(
  fetchProviders: FetchModelsDevProviders = defaultFetch,
): Promise<OpenRouterPriceCatalog> {
  return createModelsDevCatalog(fetchProviders);
}

function uniqueBareEntries<T>(byId: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  const byBareId = new Map<string, T>();
  const duplicateBareIds = new Set<string>();

  for (const [id, value] of byId) {
    const bareId = id.split('/').at(-1) ?? id;
    if (byBareId.has(bareId)) {
      duplicateBareIds.add(bareId);
      byBareId.delete(bareId);
      continue;
    }
    if (!duplicateBareIds.has(bareId)) {
      byBareId.set(bareId, value);
    }
  }
  return byBareId;
}

function parsePrices(providers: ProviderMap): readonly OpenRouterModelPrice[] {
  const openrouter = providers[openRouterProviderId];
  return openrouter === undefined ? [] : Object.values(openrouter.models).flatMap(parsePrice);
}

function parsePrice(model: Model): readonly OpenRouterModelPrice[] {
  if (model.cost === undefined) {
    return [];
  }
  const cost = model.cost;

  return [
    {
      id: model.id,
      input: cost.input,
      output: cost.output,
      ...(cost.cache_read === undefined ? {} : { cacheRead: cost.cache_read }),
      ...(cost.cache_write === undefined ? {} : { cacheWrite: cost.cache_write }),
      ...(cost.reasoning === undefined ? {} : { reasoning: cost.reasoning }),
    },
  ];
}

function parseMetadata(providers: ProviderMap): MetadataCatalog {
  const candidates = new Map<string, Map<string, Model>>();
  const byOpenRouterId = new Map<string, Model>();
  const byProvider = new Map<string, ReadonlyMap<string, Model>>();

  for (const [providerId, provider] of Object.entries(providers)) {
    const providerMetadata = new Map<string, Model>();
    for (const model of Object.values(provider.models)) {
      const bareId = model.id.split('/').at(-1) ?? model.id;
      providerMetadata.set(model.id, model);
      providerMetadata.set(bareId, model);
      addMetadataCandidate(candidates, model.id, model);
      addMetadataCandidate(candidates, bareId, model);
      if (providerId === openRouterProviderId) {
        byOpenRouterId.set(model.id, model);
      }
    }
    byProvider.set(providerId, providerMetadata);
  }

  const byModelId = new Map<string, Model>();
  for (const [modelId, values] of candidates) {
    if (values.size === 1) {
      const metadata = values.values().next().value;
      if (metadata !== undefined) byModelId.set(modelId, metadata);
    }
  }
  return {
    byModelId,
    byOpenRouterBareId: uniqueBareEntries(byOpenRouterId),
    byOpenRouterId,
    byProvider,
  };
}

function resolveMetadata(catalog: MetadataCatalog, modelId: string): Model | undefined {
  const slashIndex = modelId.indexOf('/');
  const bareId = modelId.split('/').at(-1) ?? modelId;
  const providerId = slashIndex > 0 ? modelId.slice(0, slashIndex) : canonicalProviderId(bareId);
  const providerMetadata = providerId === undefined ? undefined : catalog.byProvider.get(providerId);
  return (
    catalog.byOpenRouterId.get(modelId) ??
    catalog.byOpenRouterBareId.get(bareId) ??
    providerMetadata?.get(modelId) ??
    providerMetadata?.get(bareId) ??
    catalog.byModelId.get(modelId) ??
    catalog.byModelId.get(bareId)
  );
}

function canonicalProviderId(modelId: string): 'anthropic' | 'openai' | undefined {
  if (modelId.startsWith('claude-')) {
    return 'anthropic';
  }
  if (/^(?:chatgpt-|codex-|dall-e-|gpt-|o[1-9](?:-|$)|text-embedding-|tts-|whisper-)/u.test(modelId)) {
    return 'openai';
  }
  return undefined;
}

function addMetadataCandidate(candidates: Map<string, Map<string, Model>>, modelId: string, model: Model): void {
  const values = candidates.get(modelId) ?? new Map<string, Model>();
  // Dedup by full content: two providers exposing the same id with identical
  // records collapse to one, but differing records stay in conflict and are
  // dropped by parseMetadata (size > 1).
  values.set(JSON.stringify(model), model);
  candidates.set(modelId, values);
}

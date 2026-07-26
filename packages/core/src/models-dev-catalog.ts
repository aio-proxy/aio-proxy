import {
  type Modalities,
  type Model,
  Models,
  type ProviderMap,
  type ReasoningOption,
  type RequestOptions,
} from '@opencode-ai/models';

import type { OpenRouterModelPrice } from './usage-pricing';

export type OpenRouterPriceCatalog = {
  readonly find: (modelId: string) => OpenRouterModelPrice | undefined;
};

export type ModelsDevCatalog = OpenRouterPriceCatalog & {
  readonly displayName: (modelId: string) => string | undefined;
  readonly metadata: (modelId: string) => ModelsDevModelMetadata | undefined;
};

// Raw models.dev signals are passed through untouched; consumers that need a
// provider-specific shape (e.g. the Anthropic capabilities superset on
// /v1/models) derive it at their own boundary.
export type ModelsDevModelMetadata = {
  readonly reasoning?: boolean;
  readonly reasoning_options?: readonly ReasoningOption[];
  readonly modalities?: Modalities;
  readonly structured_output?: boolean;
  readonly displayName?: string;
  readonly maxInputTokens?: number;
  readonly maxTokens?: number;
  readonly releaseDate?: string;
};

export type FetchModelsDevProviders = (options?: RequestOptions) => Promise<ProviderMap>;
export type FetchOpenRouterPrices = FetchModelsDevProviders;

type MetadataCatalog = {
  readonly byModelId: ReadonlyMap<string, ModelsDevModelMetadata>;
  readonly byOpenRouterBareId: ReadonlyMap<string, ModelsDevModelMetadata>;
  readonly byOpenRouterId: ReadonlyMap<string, ModelsDevModelMetadata>;
  readonly byProvider: ReadonlyMap<string, ReadonlyMap<string, ModelsDevModelMetadata>>;
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
      return resolveMetadata(metadata, modelId)?.displayName;
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
  const candidates = new Map<string, Map<string, ModelsDevModelMetadata>>();
  const byOpenRouterId = new Map<string, ModelsDevModelMetadata>();
  const byProvider = new Map<string, ReadonlyMap<string, ModelsDevModelMetadata>>();

  for (const [providerId, provider] of Object.entries(providers)) {
    const providerMetadata = new Map<string, ModelsDevModelMetadata>();
    for (const model of Object.values(provider.models)) {
      const bareId = model.id.split('/').at(-1) ?? model.id;
      const metadata = metadataFromProvider(model);
      providerMetadata.set(model.id, metadata);
      providerMetadata.set(bareId, metadata);
      addMetadataCandidate(candidates, model.id, metadata);
      addMetadataCandidate(candidates, bareId, metadata);
      if (providerId === openRouterProviderId) {
        byOpenRouterId.set(model.id, metadata);
      }
    }
    byProvider.set(providerId, providerMetadata);
  }

  const byModelId = new Map<string, ModelsDevModelMetadata>();
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

function resolveMetadata(catalog: MetadataCatalog, modelId: string): ModelsDevModelMetadata | undefined {
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

function metadataFromProvider(model: Model): ModelsDevModelMetadata {
  return {
    ...(model.name === model.id ? {} : { displayName: model.name }),
    ...(model.reasoning_options === undefined ? {} : { reasoning_options: model.reasoning_options }),
    modalities: model.modalities,
    maxInputTokens: model.limit.input ?? model.limit.context,
    maxTokens: model.limit.output,
    reasoning: model.reasoning,
    releaseDate: model.release_date,
    ...(model.structured_output === undefined ? {} : { structured_output: model.structured_output }),
  };
}

function addMetadataCandidate(
  candidates: Map<string, Map<string, ModelsDevModelMetadata>>,
  modelId: string,
  metadata: ModelsDevModelMetadata,
): void {
  const values = candidates.get(modelId) ?? new Map<string, ModelsDevModelMetadata>();
  values.set(JSON.stringify(metadata), metadata);
  candidates.set(modelId, values);
}

import type { ModelCapabilities } from "@anthropic-ai/sdk/resources/models";
import { type Catalog, type Model, type ModelMetadata, Models } from "@opencode-ai/models";

export type OpenRouterModelPrice = {
  readonly id: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
};

export type UsagePricingInput = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
};

export type UsageCostResult = {
  readonly priceModelId: string;
  readonly estimatedCostUsd: number;
};

export type OpenRouterPriceCatalog = {
  readonly find: (modelId: string) => OpenRouterModelPrice | undefined;
};

export type ModelsDevCatalog = OpenRouterPriceCatalog & {
  readonly displayName: (modelId: string) => string | undefined;
  readonly metadata: (modelId: string) => ModelsDevModelMetadata | undefined;
};

export type ModelsDevCapabilities = Pick<
  ModelCapabilities,
  "effort" | "image_input" | "pdf_input" | "structured_outputs" | "thinking"
>;

export type ModelsDevModelMetadata = {
  readonly capabilities?: ModelsDevCapabilities;
  readonly displayName?: string;
  readonly maxInputTokens?: number;
  readonly maxTokens?: number;
  readonly releaseDate?: string;
};

export type FetchModelsDevCatalog = () => Promise<Catalog>;
export type FetchOpenRouterPrices = FetchModelsDevCatalog;

type MetadataCatalog = {
  readonly byCanonicalId: ReadonlyMap<string, ModelsDevModelMetadata>;
  readonly byModelId: ReadonlyMap<string, ModelsDevModelMetadata>;
  readonly byProvider: ReadonlyMap<string, ReadonlyMap<string, ModelsDevModelMetadata>>;
};

const modelsDev = Models.make();
const defaultFetch: FetchModelsDevCatalog = () => modelsDev.catalog();

export async function createModelsDevCatalog(
  fetchCatalog: FetchModelsDevCatalog = defaultFetch,
): Promise<ModelsDevCatalog> {
  const value = await fetchCatalog();
  const prices = parsePrices(value);
  const byId = new Map(prices.map((price) => [price.id, price]));
  const byBareId = uniqueBarePrices(prices);
  const metadata = parseMetadata(value);

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
  fetchCatalog: FetchModelsDevCatalog = defaultFetch,
): Promise<OpenRouterPriceCatalog> {
  return createModelsDevCatalog(fetchCatalog);
}

function uniqueBarePrices(prices: readonly OpenRouterModelPrice[]): ReadonlyMap<string, OpenRouterModelPrice> {
  const byBareId = new Map<string, OpenRouterModelPrice>();
  const duplicateBareIds = new Set<string>();

  for (const price of prices) {
    const bareId = price.id.split("/").at(-1) ?? price.id;
    if (byBareId.has(bareId)) {
      duplicateBareIds.add(bareId);
      byBareId.delete(bareId);
      continue;
    }
    if (!duplicateBareIds.has(bareId)) {
      byBareId.set(bareId, price);
    }
  }
  return byBareId;
}

export function calculateEstimatedCost(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
): UsageCostResult | undefined {
  let cost = 0;
  let priced = false;

  const add = (tokens: number | undefined, unitPrice: number | undefined) => {
    if (tokens === undefined || unitPrice === undefined) {
      return;
    }
    cost += (tokens * unitPrice) / 1_000_000;
    priced = true;
  };

  add(usage.inputTokens, price.input);
  add(usage.outputTokens, price.output);
  add(usage.cacheReadTokens, price.cacheRead);
  add(usage.cacheWriteTokens, price.cacheWrite);
  add(usage.reasoningTokens, price.reasoning);

  return priced ? { estimatedCostUsd: cost, priceModelId: price.id } : undefined;
}

function parsePrices(value: Catalog): readonly OpenRouterModelPrice[] {
  const openrouter = value.providers.openrouter;
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

function parseMetadata(value: Catalog): MetadataCatalog {
  const candidates = new Map<string, Map<string, ModelsDevModelMetadata>>();
  const byCanonicalId = new Map<string, ModelsDevModelMetadata>();
  const byProvider = new Map<string, ReadonlyMap<string, ModelsDevModelMetadata>>();

  for (const [canonicalId, model] of Object.entries(value.models)) {
    byCanonicalId.set(canonicalId, metadataFromCanonical(model));
  }

  for (const [providerId, provider] of Object.entries(value.providers)) {
    const providerMetadata = new Map<string, ModelsDevModelMetadata>();
    for (const model of Object.values(provider.models)) {
      const bareId = model.id.split("/").at(-1) ?? model.id;
      const canonicalId = canonicalModelId(providerId, model.id);
      const metadata = metadataFromProvider(model, canonicalId === undefined ? undefined : value.models[canonicalId]);
      providerMetadata.set(model.id, metadata);
      providerMetadata.set(bareId, metadata);
      addMetadataCandidate(candidates, model.id, metadata);
      addMetadataCandidate(candidates, bareId, metadata);
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
  return { byCanonicalId, byModelId, byProvider };
}

function resolveMetadata(catalog: MetadataCatalog, modelId: string): ModelsDevModelMetadata | undefined {
  const slashIndex = modelId.indexOf("/");
  const bareId = modelId.split("/").at(-1) ?? modelId;
  const providerId = slashIndex > 0 ? modelId.slice(0, slashIndex) : canonicalProviderId(bareId);
  const canonicalId = providerId === undefined ? undefined : `${providerId}/${bareId}`;
  const providerMetadata = providerId === undefined ? undefined : catalog.byProvider.get(providerId);
  return (
    providerMetadata?.get(modelId) ??
    providerMetadata?.get(bareId) ??
    (canonicalId === undefined ? undefined : catalog.byCanonicalId.get(canonicalId)) ??
    catalog.byModelId.get(modelId) ??
    catalog.byModelId.get(bareId)
  );
}

function canonicalProviderId(modelId: string): "anthropic" | "openai" | undefined {
  if (modelId.startsWith("claude-")) {
    return "anthropic";
  }
  if (/^(?:chatgpt-|codex-|dall-e-|gpt-|o[1-9](?:-|$)|text-embedding-|tts-|whisper-)/u.test(modelId)) {
    return "openai";
  }
  return undefined;
}

function canonicalModelId(providerId: string, modelId: string): string | undefined {
  if (modelId.includes("/")) return modelId;
  const canonicalProvider =
    providerId === "anthropic" || providerId === "openai" ? providerId : canonicalProviderId(modelId);
  return canonicalProvider === undefined ? undefined : `${canonicalProvider}/${modelId}`;
}

function metadataFromCanonical(model: ModelMetadata): ModelsDevModelMetadata {
  return {
    ...(model.name === model.id ? {} : { displayName: model.name }),
    ...(model.limit === undefined
      ? {}
      : {
          maxInputTokens: model.limit.input ?? model.limit.context,
          ...(model.limit.output === undefined ? {} : { maxTokens: model.limit.output }),
        }),
    ...(model.release_date === undefined ? {} : { releaseDate: model.release_date }),
  };
}

function metadataFromProvider(model: Model, canonical: ModelMetadata | undefined): ModelsDevModelMetadata {
  const displayName = canonical?.name ?? model.name;
  return {
    capabilities: modelCapabilities(model),
    ...(displayName === model.id ? {} : { displayName }),
    maxInputTokens: model.limit.input ?? model.limit.context,
    maxTokens: model.limit.output,
    releaseDate: canonical?.release_date ?? model.release_date,
  };
}

function modelCapabilities(model: Model): ModelsDevCapabilities {
  const options = model.reasoning_options ?? [];
  const effort = options.find((option) => option.type === "effort");
  const values = effort?.values ?? [];
  return {
    effort: {
      high: support(values.includes("high")),
      low: support(values.includes("low")),
      max: support(values.includes("max")),
      medium: support(values.includes("medium")),
      supported: effort !== undefined,
      xhigh: support(values.includes("xhigh")),
    },
    image_input: support(model.modalities.input.includes("image")),
    pdf_input: support(model.modalities.input.includes("pdf")),
    structured_outputs: support(model.structured_output === true),
    thinking: {
      supported: model.reasoning,
      types: {
        adaptive: support(effort !== undefined),
        enabled: support(options.some((option) => option.type === "budget_tokens" || option.type === "toggle")),
      },
    },
  };
}

function support(supported: boolean): { readonly supported: boolean } {
  return { supported };
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

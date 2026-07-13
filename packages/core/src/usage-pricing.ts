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
};

export type FetchOpenRouterPrices = () => Promise<unknown>;

const modelsDevApiUrl = "https://models.dev/api.json";

const defaultFetch: FetchOpenRouterPrices = async () => {
  const response = await fetch(modelsDevApiUrl);
  return response.json();
};

export async function createModelsDevCatalog(
  fetchJson: FetchOpenRouterPrices = defaultFetch,
): Promise<ModelsDevCatalog> {
  const value = await fetchJson();
  const prices = parsePrices(value);
  const byId = new Map(prices.map((price) => [price.id, price]));
  const byBareId = uniqueBarePrices(prices);
  const displayNames = parseDisplayNames(value);

  return {
    displayName(modelId) {
      return displayNames.get(modelId);
    },
    find(modelId) {
      return byId.get(modelId) ?? byBareId.get(modelId);
    },
  };
}

export async function createOpenRouterPriceCatalog(
  fetchJson: FetchOpenRouterPrices = defaultFetch,
): Promise<OpenRouterPriceCatalog> {
  return createModelsDevCatalog(fetchJson);
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

function parsePrices(value: unknown): readonly OpenRouterModelPrice[] {
  if (!isRecord(value)) {
    return [];
  }
  const openrouter = value["openrouter"];
  if (!isRecord(openrouter) || !isRecord(openrouter["models"])) {
    return [];
  }

  return Object.values(openrouter["models"]).flatMap(parsePrice);
}

function parsePrice(model: unknown): readonly OpenRouterModelPrice[] {
  if (!isRecord(model) || typeof model["id"] !== "string" || !isRecord(model["cost"])) {
    return [];
  }
  const cost = model["cost"];

  return [
    {
      id: model["id"],
      ...(typeof cost["input"] === "number" ? { input: cost["input"] } : {}),
      ...(typeof cost["output"] === "number" ? { output: cost["output"] } : {}),
      ...(typeof cost["cache_read"] === "number" ? { cacheRead: cost["cache_read"] } : {}),
      ...(typeof cost["cache_write"] === "number" ? { cacheWrite: cost["cache_write"] } : {}),
      ...(typeof cost["reasoning"] === "number" ? { reasoning: cost["reasoning"] } : {}),
    },
  ];
}

function parseDisplayNames(value: unknown): ReadonlyMap<string, string> {
  const candidates = new Map<string, Set<string>>();
  if (!isRecord(value)) {
    return new Map();
  }

  for (const provider of Object.values(value)) {
    if (!isRecord(provider) || !isRecord(provider["models"])) {
      continue;
    }
    for (const model of Object.values(provider["models"])) {
      if (!isRecord(model) || typeof model["id"] !== "string" || typeof model["name"] !== "string") {
        continue;
      }
      if (model["name"] === model["id"]) {
        continue;
      }
      addDisplayName(candidates, model["id"], model["name"]);
      addDisplayName(candidates, model["id"].split("/").at(-1) ?? model["id"], model["name"]);
    }
  }

  return new Map(
    [...candidates].flatMap(([modelId, names]) =>
      names.size === 1 ? [[modelId, [...names][0] as string] as const] : [],
    ),
  );
}

function addDisplayName(candidates: Map<string, Set<string>>, modelId: string, name: string): void {
  const names = candidates.get(modelId) ?? new Set<string>();
  names.add(name);
  candidates.set(modelId, names);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { Model, ProviderMap } from '@opencode-ai/models';

import type { OpenRouterModelPrice } from '../usage-pricing';

const OPENROUTER_PROVIDER_ID = 'openrouter';

// A price index is derived once per provider map and memoized against that map's
// object identity: getProviders returns a cached map for 6h, so we reuse the
// same index across the many usage-pricing lookups that happen per request.
type PriceIndex = {
  readonly byId: ReadonlyMap<string, OpenRouterModelPrice>;
  readonly byBareId: ReadonlyMap<string, OpenRouterModelPrice>;
};

let cachedFor: ProviderMap | undefined;
let cachedIndex: PriceIndex | undefined;

// Price data comes only from the OpenRouter catalog, matching the historical
// contract: other providers' cost shapes are not comparable, so pricing that a
// caller asks for on a non-OpenRouter id resolves through OpenRouter's bare id.
export function findModelPrice(providers: ProviderMap, modelId: string): OpenRouterModelPrice | undefined {
  const index = priceIndex(providers);
  const bareId = modelId.split('/').at(-1) ?? modelId;
  return index.byId.get(modelId) ?? index.byBareId.get(bareId);
}

function priceIndex(providers: ProviderMap): PriceIndex {
  if (cachedFor === providers && cachedIndex !== undefined) return cachedIndex;
  const prices = parsePrices(providers);
  const byId = new Map(prices.map((price) => [price.id, price]));
  const index: PriceIndex = { byBareId: uniqueBareEntries(byId), byId };
  cachedFor = providers;
  cachedIndex = index;
  return index;
}

function parsePrices(providers: ProviderMap): readonly OpenRouterModelPrice[] {
  const openrouter = providers[OPENROUTER_PROVIDER_ID];
  return openrouter === undefined ? [] : Object.values(openrouter.models).flatMap(parsePrice);
}

function parsePrice(model: Model): readonly OpenRouterModelPrice[] {
  if (model.cost === undefined) return [];
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

// Bare-id lookups only resolve when unambiguous: two OpenRouter ids sharing a
// bare id (e.g. two vendors' `mistral-large`) are dropped so a bare query never
// silently returns the wrong vendor's price.
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
    if (!duplicateBareIds.has(bareId)) byBareId.set(bareId, value);
  }
  return byBareId;
}

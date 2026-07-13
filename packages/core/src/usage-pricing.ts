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

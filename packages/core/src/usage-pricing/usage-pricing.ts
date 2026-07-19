import { ProviderProtocol } from "@aio-proxy/types";

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

export type UsageAccounting =
  | { readonly source: "passthrough"; readonly protocol: ProviderProtocol }
  | { readonly source: "ai-sdk" };

export function calculateEstimatedCost(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
  accounting: UsageAccounting,
): UsageCostResult | undefined {
  const billable = toBillableUsage(usage, price, accounting);
  let costMicros = 0;
  let priced = false;

  const add = (tokens: number | undefined, unitPrice: number | undefined) => {
    if (tokens === undefined || unitPrice === undefined) {
      return;
    }
    costMicros += tokens * unitPrice;
    priced = true;
  };

  add(billable.inputTokens, price.input);
  add(billable.outputTokens, price.output);
  add(billable.cacheReadTokens, price.cacheRead);
  add(billable.cacheWriteTokens, price.cacheWrite);
  add(billable.reasoningTokens, price.reasoning);

  return priced ? { estimatedCostUsd: costMicros / 1_000_000, priceModelId: price.id } : undefined;
}

function toBillableUsage(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
  accounting: UsageAccounting,
): UsagePricingInput {
  if (accounting.source === "ai-sdk") {
    return inclusiveBillableUsage(usage, price);
  }

  switch (accounting.protocol) {
    case ProviderProtocol.Anthropic:
      return usage;
    case ProviderProtocol.OpenAICompatible:
    case ProviderProtocol.OpenAIResponse:
      return inclusiveBillableUsage(usage, price);
    case ProviderProtocol.Gemini: {
      const afterCache = peelSubsets(usage.inputTokens, [{ count: usage.cacheReadTokens, unitPrice: price.cacheRead }]);
      const thoughts = usage.reasoningTokens;
      const reasoningPriced = pricedSubset(thoughts, price.reasoning) !== undefined;
      const outputTokens =
        usage.outputTokens === undefined && thoughts === undefined
          ? undefined
          : reasoningPriced
            ? (usage.outputTokens ?? 0)
            : (usage.outputTokens ?? 0) + (thoughts ?? 0);
      return {
        ...(afterCache.parent === undefined ? {} : { inputTokens: afterCache.parent }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(pricedSubset(usage.cacheReadTokens, price.cacheRead) === undefined
          ? {}
          : { cacheReadTokens: usage.cacheReadTokens }),
        ...(reasoningPriced ? { reasoningTokens: thoughts } : {}),
      };
    }
    default: {
      const _exhaustive: never = accounting.protocol;
      return _exhaustive;
    }
  }
}

function inclusiveBillableUsage(usage: UsagePricingInput, price: OpenRouterModelPrice): UsagePricingInput {
  const afterCache = peelSubsets(usage.inputTokens, [
    { count: usage.cacheReadTokens, unitPrice: price.cacheRead },
    { count: usage.cacheWriteTokens, unitPrice: price.cacheWrite },
  ]);
  const afterReasoning = peelSubsets(usage.outputTokens, [
    { count: usage.reasoningTokens, unitPrice: price.reasoning },
  ]);
  return {
    ...(afterCache.parent === undefined ? {} : { inputTokens: afterCache.parent }),
    ...(afterReasoning.parent === undefined ? {} : { outputTokens: afterReasoning.parent }),
    ...(pricedSubset(usage.cacheReadTokens, price.cacheRead) === undefined
      ? {}
      : { cacheReadTokens: usage.cacheReadTokens }),
    ...(pricedSubset(usage.cacheWriteTokens, price.cacheWrite) === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(pricedSubset(usage.reasoningTokens, price.reasoning) === undefined
      ? {}
      : { reasoningTokens: usage.reasoningTokens }),
  };
}

function peelSubsets(
  parent: number | undefined,
  subsets: readonly { readonly count: number | undefined; readonly unitPrice: number | undefined }[],
): { readonly parent: number | undefined } {
  if (parent === undefined) {
    return { parent: undefined };
  }
  let next = parent;
  for (const subset of subsets) {
    if (pricedSubset(subset.count, subset.unitPrice) === undefined || subset.count === undefined) {
      continue;
    }
    next = Math.max(0, next - subset.count);
  }
  return { parent: next };
}

function pricedSubset(count: number | undefined, unitPrice: number | undefined): number | undefined {
  return count !== undefined && unitPrice !== undefined ? count : undefined;
}

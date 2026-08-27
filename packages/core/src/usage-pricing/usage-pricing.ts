import { ProviderProtocol } from '@aio-proxy/types';
import type { ModelCost } from '@aio-proxy/types';

export type OpenRouterModelPriceTier = {
  readonly threshold: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly inputAudio?: number;
  readonly outputAudio?: number;
};

export type OpenRouterModelPrice = {
  readonly id: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly inputAudio?: number;
  readonly outputAudio?: number;
  readonly image?: number;
  readonly webSearch?: number;
  readonly request?: number;
  readonly tiers?: readonly OpenRouterModelPriceTier[];
};

export type UsagePricingInput = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly inputAudioTokens?: number;
  readonly outputAudioTokens?: number;
  readonly imageCount?: number;
  readonly webSearchCount?: number;
};

export type UsageCostResult = {
  readonly priceModelId: string;
  readonly estimatedCostUsd: number;
};

export type UsageAccounting =
  | { readonly source: 'passthrough'; readonly protocol: ProviderProtocol }
  | { readonly source: 'ai-sdk' };

export function configModelPrice(modelId: string, cost: ModelCost): OpenRouterModelPrice {
  return {
    id: modelId,
    ...(cost.input === undefined ? {} : { input: cost.input }),
    ...(cost.output === undefined ? {} : { output: cost.output }),
    ...(cost.cacheRead === undefined ? {} : { cacheRead: cost.cacheRead }),
    ...(cost.cacheWrite === undefined ? {} : { cacheWrite: cost.cacheWrite }),
    ...(cost.reasoning === undefined ? {} : { reasoning: cost.reasoning }),
    ...(cost.inputAudio === undefined ? {} : { inputAudio: cost.inputAudio }),
    ...(cost.outputAudio === undefined ? {} : { outputAudio: cost.outputAudio }),
    ...(cost.image === undefined ? {} : { image: cost.image }),
    ...(cost.webSearch === undefined ? {} : { webSearch: cost.webSearch }),
    ...(cost.request === undefined ? {} : { request: cost.request }),
    ...(cost.tiers === undefined
      ? {}
      : {
          tiers: cost.tiers.map((tier) => ({
            threshold: tier.tier.size,
            ...(tier.input === undefined ? {} : { input: tier.input }),
            ...(tier.output === undefined ? {} : { output: tier.output }),
            ...(tier.cacheRead === undefined ? {} : { cacheRead: tier.cacheRead }),
            ...(tier.cacheWrite === undefined ? {} : { cacheWrite: tier.cacheWrite }),
            ...(tier.reasoning === undefined ? {} : { reasoning: tier.reasoning }),
            ...(tier.inputAudio === undefined ? {} : { inputAudio: tier.inputAudio }),
            ...(tier.outputAudio === undefined ? {} : { outputAudio: tier.outputAudio }),
          })),
        }),
  };
}

export function tierAdjustedPrice(usage: UsagePricingInput, price: OpenRouterModelPrice): OpenRouterModelPrice {
  if (price.tiers === undefined || price.tiers.length === 0) {
    return price;
  }
  const inputTokens = usage.inputTokens ?? 0;
  const crossed = price.tiers
    .filter((tier) => inputTokens > tier.threshold)
    .reduce<OpenRouterModelPriceTier | undefined>(
      (best, tier) => (best === undefined || tier.threshold > best.threshold ? tier : best),
      undefined,
    );
  if (crossed === undefined) {
    return price;
  }
  return {
    ...price,
    ...(crossed.input === undefined ? {} : { input: crossed.input }),
    ...(crossed.output === undefined ? {} : { output: crossed.output }),
    ...(crossed.cacheRead === undefined ? {} : { cacheRead: crossed.cacheRead }),
    ...(crossed.cacheWrite === undefined ? {} : { cacheWrite: crossed.cacheWrite }),
    ...(crossed.reasoning === undefined ? {} : { reasoning: crossed.reasoning }),
    ...(crossed.inputAudio === undefined ? {} : { inputAudio: crossed.inputAudio }),
    ...(crossed.outputAudio === undefined ? {} : { outputAudio: crossed.outputAudio }),
  };
}

export function calculateEstimatedCost(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
  accounting: UsageAccounting,
): UsageCostResult | undefined {
  const tokenPrice = tierAdjustedPrice(usage, price);
  const billable = toBillableUsage(usage, tokenPrice, accounting);
  let costMicros = 0;
  let priced = false;

  const addTokens = (tokens: number | undefined, unitPrice: number | undefined) => {
    if (tokens === undefined || unitPrice === undefined) {
      return;
    }
    costMicros += tokens * unitPrice;
    priced = true;
  };

  const addFee = (count: number | undefined, unitFee: number | undefined) => {
    if (unitFee === undefined || count === undefined || count <= 0) {
      return;
    }
    costMicros += unitFee * count * 1_000_000;
    priced = true;
  };

  addTokens(billable.inputTokens, tokenPrice.input);
  addTokens(billable.outputTokens, tokenPrice.output);
  addTokens(billable.cacheReadTokens, tokenPrice.cacheRead);
  addTokens(billable.cacheWriteTokens, tokenPrice.cacheWrite);
  addTokens(billable.reasoningTokens, tokenPrice.reasoning);
  addTokens(billable.inputAudioTokens, tokenPrice.inputAudio);
  addTokens(billable.outputAudioTokens, tokenPrice.outputAudio);

  addFee(usage.imageCount, price.image);
  addFee(usage.webSearchCount, price.webSearch);
  addFee(price.request === undefined ? undefined : 1, price.request);

  return priced ? { estimatedCostUsd: costMicros / 1_000_000, priceModelId: price.id } : undefined;
}

function toBillableUsage(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
  accounting: UsageAccounting,
): UsagePricingInput {
  if (accounting.source === 'ai-sdk') {
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
      let outputTokens: number | undefined;
      if (usage.outputTokens !== undefined || thoughts !== undefined) {
        outputTokens = usage.outputTokens ?? 0;
        if (!reasoningPriced) outputTokens += thoughts ?? 0;
      }
      return {
        ...(afterCache.parent === undefined ? {} : { inputTokens: afterCache.parent }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(pricedSubset(usage.cacheReadTokens, price.cacheRead) === undefined
          ? {}
          : { cacheReadTokens: usage.cacheReadTokens }),
        ...(reasoningPriced ? { reasoningTokens: thoughts } : {}),
      };
    }
    case ProviderProtocol.OpenAIImage:
      return usage;
    default: {
      const _exhaustive: never = accounting.protocol;
      return _exhaustive;
    }
  }
}

function inclusiveBillableUsage(usage: UsagePricingInput, price: OpenRouterModelPrice): UsagePricingInput {
  // Audio tokens are a subset of their parent totals (OpenAI reports
  // prompt_tokens_details.audio_tokens ⊆ prompt_tokens, and the completion
  // equivalent), so they peel out of input/output like cache and reasoning do.
  // Billing the raw audio count on top of an un-peeled parent double-charges
  // those tokens at both the text and audio rate.
  const afterCache = peelSubsets(usage.inputTokens, [
    { count: usage.cacheReadTokens, unitPrice: price.cacheRead },
    { count: usage.cacheWriteTokens, unitPrice: price.cacheWrite },
    { count: usage.inputAudioTokens, unitPrice: price.inputAudio },
  ]);
  const afterReasoning = peelSubsets(usage.outputTokens, [
    { count: usage.reasoningTokens, unitPrice: price.reasoning },
    { count: usage.outputAudioTokens, unitPrice: price.outputAudio },
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
    ...(pricedSubset(usage.inputAudioTokens, price.inputAudio) === undefined
      ? {}
      : { inputAudioTokens: usage.inputAudioTokens }),
    ...(pricedSubset(usage.outputAudioTokens, price.outputAudio) === undefined
      ? {}
      : { outputAudioTokens: usage.outputAudioTokens }),
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
  return count !== undefined && unitPrice !== undefined && Number.isFinite(unitPrice) ? count : undefined;
}

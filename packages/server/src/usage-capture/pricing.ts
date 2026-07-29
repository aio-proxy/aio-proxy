import {
  calculateEstimatedCost,
  findModelPrice,
  getProviders,
  type TextStreamPart,
  type ToolSet,
  type UsageAccounting,
} from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

type FinishPart = Extract<TextStreamPart<ToolSet>, { readonly type: 'finish' }>;

export function normalizeAiSdkUsage(part: FinishPart, providerId: string, modelId: string): UsageRow | undefined {
  const usage = part.totalUsage;
  const normalized = {
    providerId,
    modelId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.inputTokenDetails?.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.inputTokenDetails?.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }),
    ...(usage.outputTokenDetails?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
  };
  return Object.keys(normalized).length === 2 ? undefined : normalized;
}

export async function priceUsage(
  usage: UsageRow | undefined,
  accounting: UsageAccounting,
  requestedModelId?: string,
): Promise<UsageRow | undefined> {
  if (usage === undefined) return undefined;
  try {
    const providers = await getProviders();
    // Price the resolved target first: usage.modelId is the alias/variant the
    // Router selected, so it is the authoritative billed model. Fall back to
    // the requested alias only when the resolved target has no catalog entry
    // (e.g. an opaque upstream relay id), so relayed models still get priced.
    const price =
      findModelPrice(providers, usage.modelId) ??
      (requestedModelId === undefined ? undefined : findModelPrice(providers, requestedModelId));
    const cost = price === undefined ? undefined : calculateEstimatedCost(pricingInput(usage), price, accounting);
    return cost === undefined ? usage : { ...usage, ...cost };
  } catch {
    return usage;
  }
}

function pricingInput(usage: UsageRow) {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

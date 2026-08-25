import type { OpenRouterModelPrice } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

import { finalizeUsage } from '../usage-validation';

const TOKEN_FIELDS = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['total_tokens', 'totalTokens'],
] as const;

export async function captureImageUsage(options: {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  readonly imageCount: number;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly configPrice?: OpenRouterModelPrice;
}): Promise<UsageRow | undefined> {
  const tokens: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  for (const [official, row] of TOKEN_FIELDS) {
    const value = options.usage?.[official];
    if (typeof value === 'number') tokens[row] = value;
  }
  return finalizeUsage({
    usage: {
      providerId: options.providerId,
      modelId: options.modelId,
      imageCount: options.imageCount,
      ...tokens,
    },
    accounting: { source: 'ai-sdk' },
    providerId: options.providerId,
    modelId: options.modelId,
    ...(options.requestedModelId === undefined ? {} : { requestedModelId: options.requestedModelId }),
    ...(options.configPrice === undefined ? {} : { configPrice: options.configPrice }),
  });
}

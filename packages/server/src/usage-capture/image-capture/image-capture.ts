import type { OpenRouterModelPrice } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

import { finalizeUsage } from '../usage-validation';

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'inputAudioTokens',
  'outputAudioTokens',
] as const;

export async function captureImageUsage(options: {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  readonly imageCount: number;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly configPrice?: OpenRouterModelPrice;
}): Promise<UsageRow | undefined> {
  const tokens: { [K in (typeof TOKEN_FIELDS)[number]]?: number } = {};
  for (const field of TOKEN_FIELDS) {
    const value = options.usage?.[field];
    if (typeof value === 'number') tokens[field] = value;
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

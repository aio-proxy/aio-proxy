import type { OpenRouterModelPrice } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

import { finalizeUsage } from '../usage-validation';

/**
 * Neither SpeechResult nor TranscriptionResult carries usage, so this exists
 * only so a configured per-request fee reaches accounting: `finalizeUsage`'s
 * `seedForRequestFee` emits a `{providerId, modelId}` row when `usage` is
 * undefined and `configPrice.request > 0`, and returns undefined otherwise.
 * Passing `usage: undefined` is deliberate — audio token counts are never
 * estimated from duration or byte length.
 */
export async function captureAudioUsage(options: {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId?: string;
  readonly configPrice?: OpenRouterModelPrice;
}): Promise<UsageRow | undefined> {
  return finalizeUsage({
    usage: undefined,
    accounting: { source: 'ai-sdk' },
    providerId: options.providerId,
    modelId: options.modelId,
    ...(options.requestedModelId === undefined ? {} : { requestedModelId: options.requestedModelId }),
    ...(options.configPrice === undefined ? {} : { configPrice: options.configPrice }),
  });
}

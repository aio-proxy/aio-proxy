import type { ServerLogSink } from '../server-log';
import { type EmbeddingUsageOptions, type UsageCompletion, usageProperty } from './shared';
import { finalizeUsage } from './usage-validation';

// Embedding upstreams report one prompt-token count for the whole batch. Mirror
// it onto inputTokens and totalTokens so pricing, traces, and the dashboard read
// it like any other buffered response. finalizeUsage still validates the count,
// so a fractional or unsafe number drops the row instead of billing it.
export async function embeddingCapture(
  { usage, providerId, modelId, requestedModelId, configPrice }: EmbeddingUsageOptions,
  logger: ServerLogSink | undefined,
): Promise<UsageCompletion> {
  const tokens = usage?.tokens;
  const row = await finalizeUsage({
    usage: tokens === undefined ? undefined : { providerId, modelId, inputTokens: tokens, totalTokens: tokens },
    accounting: { source: 'ai-sdk' },
    providerId,
    modelId,
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    ...(configPrice === undefined ? {} : { configPrice }),
    ...(logger === undefined ? {} : { logger }),
  });
  return { outcome: 'success', ...usageProperty(row) };
}

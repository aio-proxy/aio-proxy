import { z } from 'zod';

import { IdSchema } from './common';

// oxlint-disable-next-line typescript/no-deprecated -- Keep the finite boundary explicit in the public schema.
const TokenCountSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const RequestOutcomeSchema = z.enum(['success', 'failure', 'cancelled']);
export const UsageOverviewRangeSchema = z.enum(['24h', '7d', '14d', '30d']);
export const DashboardOverviewRangeSchema = z.enum(['24h', '7d', '30d', '90d']);
export const UsageOverviewMetricSchema = z.enum(['cost', 'tokens', 'requests']);
export const UsageOverviewGroupBySchema = z.enum(['model', 'provider']);

// Where the price used for estimatedCostUsd came from: an explicit per-provider
// config override, the models.dev catalog, or (reserved) a built-in default.
export const PriceSourceSchema = z.enum(['config', 'models-dev', 'default']);

export const UsageRowSchema = z.object({
  providerId: IdSchema,
  modelId: IdSchema,
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  totalTokens: TokenCountSchema.optional(),
  cacheReadTokens: TokenCountSchema.optional(),
  cacheWriteTokens: TokenCountSchema.optional(),
  reasoningTokens: TokenCountSchema.optional(),
  inputAudioTokens: TokenCountSchema.optional(),
  outputAudioTokens: TokenCountSchema.optional(),
  // Per-EVENT counts (not tokens): generated images and web-search invocations
  // that downstream pricing charges as per-event fees, distinct from the token fields above.
  imageCount: TokenCountSchema.optional(),
  webSearchCount: TokenCountSchema.optional(),
  priceModelId: IdSchema.optional(),
  // oxlint-disable-next-line typescript/no-deprecated -- Keep the finite boundary explicit in the public schema.
  estimatedCostUsd: z.number().finite().min(0).optional(),
  priceSource: PriceSourceSchema.optional(),
});

export type UsageRowInput = z.input<typeof UsageRowSchema>;
export type UsageRow = z.output<typeof UsageRowSchema>;
export type PriceSource = z.output<typeof PriceSourceSchema>;
export type RequestOutcome = z.output<typeof RequestOutcomeSchema>;
export type UsageOverviewRange = z.output<typeof UsageOverviewRangeSchema>;
export type DashboardOverviewRange = z.output<typeof DashboardOverviewRangeSchema>;
export type UsageOverviewMetric = z.output<typeof UsageOverviewMetricSchema>;
export type UsageOverviewGroupBy = z.output<typeof UsageOverviewGroupBySchema>;

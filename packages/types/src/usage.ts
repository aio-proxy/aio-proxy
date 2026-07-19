import { z } from "zod";

import { IdSchema } from "./common";

const TokenCountSchema = z.number().int().min(0);

export const RequestOutcomeSchema = z.enum(["success", "failure", "cancelled"]);
export const UsageOverviewRangeSchema = z.enum(["24h", "7d", "14d", "30d"]);
export const UsageOverviewMetricSchema = z.enum(["cost", "tokens", "requests"]);
export const UsageOverviewGroupBySchema = z.enum(["model", "provider"]);

export const UsageRowSchema = z.object({
  providerId: IdSchema,
  modelId: IdSchema,
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  totalTokens: TokenCountSchema.optional(),
  cacheReadTokens: TokenCountSchema.optional(),
  cacheWriteTokens: TokenCountSchema.optional(),
  reasoningTokens: TokenCountSchema.optional(),
  priceModelId: IdSchema.optional(),
  estimatedCostUsd: z.number().min(0).optional(),
});

export type UsageRowInput = z.input<typeof UsageRowSchema>;
export type UsageRow = z.output<typeof UsageRowSchema>;
export type RequestOutcome = z.output<typeof RequestOutcomeSchema>;
export type UsageOverviewRange = z.output<typeof UsageOverviewRangeSchema>;
export type UsageOverviewMetric = z.output<typeof UsageOverviewMetricSchema>;
export type UsageOverviewGroupBy = z.output<typeof UsageOverviewGroupBySchema>;

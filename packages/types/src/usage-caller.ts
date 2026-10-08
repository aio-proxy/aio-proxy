import { z } from 'zod';

export const UsageCallerSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string(),
  kind: z.enum(['key', 'agent', 'anonymous', 'legacy']),
});
export type UsageCaller = z.output<typeof UsageCallerSchema>;
export const UsageCallerRankingSchema = UsageCallerSchema.extend({
  requestCount: z.string().regex(/^\d+$/u),
  totalTokens: z.string().regex(/^\d+$/u),
  estimatedCostNanoUsd: z.string().regex(/^\d+$/u),
});
export type UsageCallerRanking = z.output<typeof UsageCallerRankingSchema>;

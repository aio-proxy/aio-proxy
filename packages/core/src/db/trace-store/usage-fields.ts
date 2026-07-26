import { traceSpan } from '../schema';

// Single source of truth for "which columns count as usage". Both the SQL
// aggregate (usage-overview) and the JS row projection (trace-queries) derive
// from this list so a request with any persisted usage field—not only
// inputTokens—is treated as having usage.
export const usageColumnKeys = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'estimatedCostUsd',
] as const;

export type UsageColumnKey = (typeof usageColumnKeys)[number];

export const usageColumns = usageColumnKeys.map((key) => traceSpan[key]);

export function hasAnyUsage(row: Pick<typeof traceSpan.$inferSelect, UsageColumnKey>): boolean {
  return usageColumnKeys.some((key) => row[key] !== null);
}

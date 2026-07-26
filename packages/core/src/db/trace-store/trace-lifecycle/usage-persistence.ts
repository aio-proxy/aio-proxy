import { sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { usdToNanoUsd } from '../../../usage-numbers';
import { usageDaily } from '../../schema';
import type { TraceCompletion, TraceTerminalSummary } from '../types';

export type PreparedUsage = {
  readonly estimatedCostNanoUsd: number | undefined;
  readonly hasUsage: boolean;
  readonly totalTokens: number;
};

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function prepareUsage(usage: TraceTerminalSummary['usage']): PreparedUsage {
  const totalTokens = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const estimatedCostNanoUsd = usage?.estimatedCostUsd === undefined ? undefined : usdToNanoUsd(usage.estimatedCostUsd);
  const hasUsage =
    usage !== undefined &&
    [
      usage.inputTokens,
      usage.outputTokens,
      usage.totalTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.reasoningTokens,
      usage.estimatedCostUsd,
    ].some((value) => value !== undefined);
  return { estimatedCostNanoUsd, hasUsage, totalTokens };
}

export function upsertUsageDelta(
  tx: BunSQLiteDatabase,
  input: TraceCompletion,
  now: Date,
  prepared: PreparedUsage,
): void {
  const { summary, session } = input;
  const modelDimension = summary.finalModelId ?? session?.requestedModelId ?? 'unknown';
  const usage = summary.usage;
  const success = summary.terminationReason === undefined;

  tx.insert(usageDaily)
    .values({
      localDay: localDay(now),
      modelDimension,
      requestCount: 1,
      successCount: success ? 1 : 0,
      errorCount: summary.terminationReason === 'failure' ? 1 : 0,
      cancelledCount: summary.terminationReason === 'cancelled' ? 1 : 0,
      interruptedCount: summary.terminationReason === 'interrupted' ? 1 : 0,
      usageRequestCount: prepared.hasUsage ? 1 : 0,
      pricedRequestCount: prepared.estimatedCostNanoUsd === undefined ? 0 : 1,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: prepared.totalTokens,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      estimatedCostNanoUsd: prepared.estimatedCostNanoUsd ?? 0,
    })
    .onConflictDoUpdate({
      target: [usageDaily.localDay, usageDaily.modelDimension],
      set: {
        requestCount: sql`request_count + excluded.request_count`,
        successCount: sql`success_count + excluded.success_count`,
        errorCount: sql`error_count + excluded.error_count`,
        cancelledCount: sql`cancelled_count + excluded.cancelled_count`,
        interruptedCount: sql`interrupted_count + excluded.interrupted_count`,
        usageRequestCount: sql`usage_request_count + excluded.usage_request_count`,
        pricedRequestCount: sql`priced_request_count + excluded.priced_request_count`,
        inputTokens: sql`input_tokens + excluded.input_tokens`,
        outputTokens: sql`output_tokens + excluded.output_tokens`,
        totalTokens: sql`total_tokens + excluded.total_tokens`,
        cacheReadTokens: sql`cache_read_tokens + excluded.cache_read_tokens`,
        cacheWriteTokens: sql`cache_write_tokens + excluded.cache_write_tokens`,
        reasoningTokens: sql`reasoning_tokens + excluded.reasoning_tokens`,
        estimatedCostNanoUsd: sql`estimated_cost_nano_usd + excluded.estimated_cost_nano_usd`,
      },
    })
    .run();
}

export function upsertInterruptedUsage(tx: BunSQLiteDatabase, count: number, now: Date): void {
  tx.insert(usageDaily)
    .values({
      localDay: localDay(now),
      modelDimension: 'unknown',
      requestCount: count,
      interruptedCount: count,
    })
    .onConflictDoUpdate({
      target: [usageDaily.localDay, usageDaily.modelDimension],
      set: {
        requestCount: sql`request_count + excluded.request_count`,
        interruptedCount: sql`interrupted_count + excluded.interrupted_count`,
      },
    })
    .run();
}

import { and, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger, usdToNanoUsd } from '../../../usage-numbers';
import { usageDaily } from '../../schema';
import type { StoredSpan, TraceCompletion, TraceTerminalSummary } from '../types';

export type PreparedUsage = {
  readonly estimatedCostNanoUsd: number | undefined;
  readonly hasUsage: boolean;
};

type UsageDailyDelta = {
  readonly requestCount: bigint;
  readonly successCount: bigint;
  readonly errorCount: bigint;
  readonly cancelledCount: bigint;
  readonly interruptedCount: bigint;
  readonly usageRequestCount: bigint;
  readonly pricedRequestCount: bigint;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly totalTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly reasoningTokens: bigint;
  readonly estimatedCostNanoUsd: bigint;
  readonly normalizedCacheReadTokens: bigint;
  readonly normalizedPromptTokens: bigint;
};

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function prepareUsage(usage: TraceTerminalSummary['usage']): PreparedUsage {
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
  return { estimatedCostNanoUsd, hasUsage };
}

export function upsertUsageDelta(
  tx: BunSQLiteDatabase,
  input: TraceCompletion,
  now: Date,
  prepared: PreparedUsage,
  childSpans: readonly StoredSpan[],
): void {
  const { summary, session } = input;
  const modelDimension = session?.requestedModelId ?? summary.finalModelId ?? 'unknown';
  const usage = summary.usage;
  const success = summary.terminationReason === undefined;
  const inputTokens = BigInt(usage?.inputTokens ?? 0);
  const outputTokens = BigInt(usage?.outputTokens ?? 0);
  const cacheReadTokens = BigInt(usage?.cacheReadTokens ?? 0);
  const cacheWriteTokens = BigInt(usage?.cacheWriteTokens ?? 0);

  addUsageDailyDelta(
    tx,
    localDay(now),
    modelDimension,
    usageDailyDelta({
      requestCount: 1n,
      successCount: success ? 1n : 0n,
      errorCount: summary.terminationReason === 'failure' ? 1n : 0n,
      cancelledCount: summary.terminationReason === 'cancelled' ? 1n : 0n,
      interruptedCount: summary.terminationReason === 'interrupted' ? 1n : 0n,
      usageRequestCount: prepared.hasUsage ? 1n : 0n,
      pricedRequestCount: prepared.estimatedCostNanoUsd === undefined ? 0n : 1n,
      inputTokens,
      outputTokens,
      totalTokens: usage?.totalTokens === undefined ? inputTokens + outputTokens : BigInt(usage.totalTokens),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: BigInt(usage?.reasoningTokens ?? 0),
      estimatedCostNanoUsd: BigInt(prepared.estimatedCostNanoUsd ?? 0),
      ...normalizedCache(childSpans, inputTokens, cacheReadTokens, cacheWriteTokens),
    }),
  );
}

const ATTEMPT_SPAN_NAME = 'aio_proxy.provider.attempt';
const TRANSPORT_ATTR = 'aio_proxy.transport';
const TARGET_PROTOCOL_ATTR = 'aio_proxy.protocol.target';
const TERMINATION_ATTR = 'aio_proxy.termination.reason';

/**
 * Cache accounting differs by capture path, and transport/protocol live on the
 * successful attempt child span rather than the rollup's dimensions. Normalize
 * here so a day range can read `sum(read) / sum(prompt)` directly.
 */
function normalizedCache(
  childSpans: readonly StoredSpan[],
  inputTokens: bigint,
  cacheReadTokens: bigint,
  cacheWriteTokens: bigint,
): Pick<UsageDailyDelta, 'normalizedCacheReadTokens' | 'normalizedPromptTokens'> {
  // The pipeline stops at the first success, so at most one attempt lacks a termination reason.
  const attempt = childSpans.find(
    (span) => span.name === ATTEMPT_SPAN_NAME && span.attributes[TERMINATION_ATTR] === undefined,
  );
  const transport = attempt?.attributes[TRANSPORT_ATTR];
  if (transport !== 'raw' && transport !== 'ai_sdk') {
    return { normalizedCacheReadTokens: 0n, normalizedPromptTokens: 0n };
  }
  const cachedTokens = cacheReadTokens + cacheWriteTokens;
  const inclusive = transport === 'raw' && attempt?.attributes[TARGET_PROTOCOL_ATTR] === 'anthropic';
  let normalizedPromptTokens = inputTokens > cachedTokens ? inputTokens : cachedTokens;
  if (inclusive) normalizedPromptTokens = inputTokens + cachedTokens;
  return {
    normalizedCacheReadTokens: cacheReadTokens,
    normalizedPromptTokens,
  };
}

export function upsertInterruptedUsage(tx: BunSQLiteDatabase, count: number, now: Date): void {
  addUsageDailyDelta(
    tx,
    localDay(now),
    'unknown',
    usageDailyDelta({ requestCount: BigInt(count), interruptedCount: BigInt(count) }),
  );
}

function usageDailyDelta(overrides: Partial<UsageDailyDelta>): UsageDailyDelta {
  return {
    requestCount: 0n,
    successCount: 0n,
    errorCount: 0n,
    cancelledCount: 0n,
    interruptedCount: 0n,
    usageRequestCount: 0n,
    pricedRequestCount: 0n,
    inputTokens: 0n,
    outputTokens: 0n,
    totalTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    reasoningTokens: 0n,
    estimatedCostNanoUsd: 0n,
    normalizedCacheReadTokens: 0n,
    normalizedPromptTokens: 0n,
    ...overrides,
  };
}

function addUsageDailyDelta(
  tx: BunSQLiteDatabase,
  localDay: string,
  modelDimension: string,
  delta: UsageDailyDelta,
): void {
  const where = and(eq(usageDaily.localDay, localDay), eq(usageDaily.modelDimension, modelDimension));
  const existing = tx.select().from(usageDaily).where(where).get();
  const values = {
    requestCount: addDecimal(existing?.requestCount, delta.requestCount),
    successCount: addDecimal(existing?.successCount, delta.successCount),
    errorCount: addDecimal(existing?.errorCount, delta.errorCount),
    cancelledCount: addDecimal(existing?.cancelledCount, delta.cancelledCount),
    interruptedCount: addDecimal(existing?.interruptedCount, delta.interruptedCount),
    usageRequestCount: addDecimal(existing?.usageRequestCount, delta.usageRequestCount),
    pricedRequestCount: addDecimal(existing?.pricedRequestCount, delta.pricedRequestCount),
    inputTokens: addDecimal(existing?.inputTokens, delta.inputTokens),
    outputTokens: addDecimal(existing?.outputTokens, delta.outputTokens),
    totalTokens: addDecimal(existing?.totalTokens, delta.totalTokens),
    cacheReadTokens: addDecimal(existing?.cacheReadTokens, delta.cacheReadTokens),
    cacheWriteTokens: addDecimal(existing?.cacheWriteTokens, delta.cacheWriteTokens),
    reasoningTokens: addDecimal(existing?.reasoningTokens, delta.reasoningTokens),
    estimatedCostNanoUsd: addDecimal(existing?.estimatedCostNanoUsd, delta.estimatedCostNanoUsd),
    normalizedCacheReadTokens: addDecimal(existing?.normalizedCacheReadTokens, delta.normalizedCacheReadTokens),
    normalizedPromptTokens: addDecimal(existing?.normalizedPromptTokens, delta.normalizedPromptTokens),
    cacheHitRateAvailable: existing?.cacheHitRateAvailable ?? 1,
  };

  if (existing === undefined) {
    tx.insert(usageDaily)
      .values({ localDay, modelDimension, ...values })
      .run();
    return;
  }
  tx.update(usageDaily).set(values).where(where).run();
}

function addDecimal(existing: string | undefined, delta: bigint): string {
  return ((existing === undefined ? 0n : parseSqliteInteger(existing)) + delta).toString();
}

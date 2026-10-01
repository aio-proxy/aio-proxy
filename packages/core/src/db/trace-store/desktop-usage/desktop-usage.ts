import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DesktopUsageRange } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { type ResolvedRange, type RootRow, bucketKeys, rangeRows, resolveRange, shiftRangeBack } from '../overview';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

export type DesktopUsageQuery = { readonly range: DesktopUsageRange; readonly now?: Date };

export type DesktopUsageTotals = {
  readonly requests: string;
  readonly failedRequests: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly estimatedCostNanoUsd: string;
  readonly pricingCoverage: number | null;
};

export type DesktopUsageSlice = {
  readonly requests: string;
  readonly failedRequests: string;
  readonly totalTokens: string;
  readonly estimatedCostNanoUsd: string;
};

export type DesktopUsageResult = {
  readonly range: DesktopUsageRange;
  readonly bucketUnit: 'hour' | 'day';
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly current: DesktopUsageTotals;
  readonly previous: DesktopUsageTotals;
  readonly buckets: readonly ({ readonly start: string } & DesktopUsageSlice)[];
  readonly byModel: readonly ({ readonly modelId: string } & DesktopUsageSlice)[];
  readonly byProvider: readonly ({ readonly providerId: string } & DesktopUsageSlice)[];
};

export const DESKTOP_USAGE_MAX_MODELS = 20;

type Totals = {
  requests: bigint;
  failed: bigint;
  input: bigint;
  output: bigint;
  cost: bigint;
  priced: bigint;
  withUsage: bigint;
};

const emptyTotals = (): Totals => ({
  requests: 0n,
  failed: 0n,
  input: 0n,
  output: 0n,
  cost: 0n,
  priced: 0n,
  withUsage: 0n,
});

// Failures follow the Dashboard overview: error and interrupted count, cancelled does not.
function add(totals: Totals, row: RootRow): void {
  const count = row.requestCount ?? 1n;
  totals.requests += count;
  if (row.terminationReason === 'failure' || row.terminationReason === 'interrupted') totals.failed += count;
  totals.input += row.inputTokens;
  totals.output += row.outputTokens;
  totals.cost += row.estimatedCostNanoUsd;
  totals.priced += BigInt(row.priced);
  totals.withUsage += BigInt(row.hasUsage);
}

const toTotals = (t: Totals): DesktopUsageTotals => ({
  requests: t.requests.toString(),
  failedRequests: t.failed.toString(),
  inputTokens: t.input.toString(),
  outputTokens: t.output.toString(),
  estimatedCostNanoUsd: t.cost.toString(),
  pricingCoverage: t.withUsage === 0n ? null : Number(t.priced) / Number(t.withUsage),
});

// Tokens are input + output everywhere in the panel, as the Dashboard's Provider table counts them.
const toSlice = (t: Totals): DesktopUsageSlice => ({
  requests: t.requests.toString(),
  failedRequests: t.failed.toString(),
  totalTokens: (t.input + t.output).toString(),
  estimatedCostNanoUsd: t.cost.toString(),
});

const byCostThenRequests = (a: Totals, b: Totals): number =>
  a.cost === b.cost ? Number(b.requests - a.requests) : b.cost > a.cost ? 1 : -1;

function totalsOf(rows: readonly RootRow[]): Totals {
  const totals = emptyTotals();
  for (const row of rows) add(totals, row);
  return totals;
}

type RawProviderRow = {
  readonly providerId: string;
  readonly requests: string;
  readonly failedRequests: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cost: string;
};

/**
 * `usage_daily` has no Provider dimension, so the per-Provider split always reads root spans, as the
 * Dashboard's Provider health table does. Trace retention (45 days) covers the 30-day window.
 * Requests that never reached a Provider (`final_provider_id` null) have no Provider to count under.
 */
function providerTotals(db: BunSQLiteDatabase, range: ResolvedRange): Map<string, Totals> {
  const sql = `select final_provider_id as providerId,
      cast(count(*) as text) as requests,
      cast(count(case when termination_reason in ('failure', 'interrupted') then 1 end) as text) as failedRequests,
      cast(coalesce(sum(input_tokens), 0) as text) as inputTokens,
      cast(coalesce(sum(output_tokens), 0) as text) as outputTokens,
      cast(coalesce(sum(estimated_cost_nano_usd), 0) as text) as cost
    from trace_span
    where parent_span_id is null and final_provider_id is not null and ended_at >= ? and ended_at <= ?
    group by final_provider_id`;
  const statement = (db as IterableDatabase).$client.query<RawProviderRow, SQLQueryBindings[]>(sql);
  const out = new Map<string, Totals>();
  for (const row of statement.all(range.start.getTime(), range.end.getTime())) {
    out.set(row.providerId, {
      requests: parseSqliteInteger(row.requests),
      failed: parseSqliteInteger(row.failedRequests),
      input: parseSqliteInteger(row.inputTokens),
      output: parseSqliteInteger(row.outputTokens),
      cost: parseSqliteInteger(row.cost),
      priced: 0n,
      withUsage: 0n,
    });
  }
  return out;
}

export function desktopUsage(db: BunSQLiteDatabase, query: DesktopUsageQuery): DesktopUsageResult {
  const now = query.now ?? new Date();
  const range = resolveRange(query.range, now);
  const rows = rangeRows(db, range);
  const previousRange = shiftRangeBack(range);

  const keys = bucketKeys(query.range, range.start, range.end);
  const byBucket = new Map<string | number, Totals>(keys.map((key) => [key.identity, emptyTotals()]));
  const byModel = new Map<string, Totals>();
  for (const row of rows) {
    const bucket = byBucket.get(row.bucket);
    if (bucket !== undefined) add(bucket, row);
    const model = byModel.get(row.dimension) ?? emptyTotals();
    add(model, row);
    byModel.set(row.dimension, model);
  }

  return {
    range: query.range,
    bucketUnit: range.bucketUnit,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    current: toTotals(totalsOf(rows)),
    previous: toTotals(totalsOf(rangeRows(db, previousRange))),
    buckets: keys.map((key) => ({ start: key.key, ...toSlice(byBucket.get(key.identity) ?? emptyTotals()) })),
    byModel: [...byModel]
      .sort(([, a], [, b]) => byCostThenRequests(a, b))
      .slice(0, DESKTOP_USAGE_MAX_MODELS)
      .map(([modelId, totals]) => ({ modelId, ...toSlice(totals) })),
    byProvider: [...providerTotals(db, range)]
      .sort(([, a], [, b]) => byCostThenRequests(a, b))
      .map(([providerId, totals]) => ({ providerId, ...toSlice(totals) })),
  };
}

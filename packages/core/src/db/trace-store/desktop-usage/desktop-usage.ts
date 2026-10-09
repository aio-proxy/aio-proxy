import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DesktopUsageRange } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { consumedUsageRows } from '../consumed-usage';
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
  /** One cell per model in `byModel` and bucket with traffic; `bucket` indexes `buckets`. */
  readonly trendByModel: readonly ({ readonly bucket: number; readonly modelId: string } & DesktopUsageSlice)[];
  /** One cell per Provider and bucket with traffic; `bucket` indexes `buckets`. */
  readonly trendByProvider: readonly ({ readonly bucket: number; readonly providerId: string } & DesktopUsageSlice)[];
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

// The name is the last tiebreak so equal entries keep their position between polls.
function byCostThenRequests([nameA, a]: [string, Totals], [nameB, b]: [string, Totals]): number {
  if (a.cost !== b.cost) return b.cost > a.cost ? 1 : -1;
  if (a.requests !== b.requests) return b.requests > a.requests ? 1 : -1;
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
}

function totalsOf(rows: readonly RootRow[]): Totals {
  const totals = emptyTotals();
  for (const row of rows) add(totals, row);
  return totals;
}

type RawAggregate = {
  readonly requests: string;
  readonly failedRequests: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cost: string;
  readonly priced?: string;
  readonly withUsage?: string;
};

const toBigTotals = (row: RawAggregate): Totals => ({
  requests: parseSqliteInteger(row.requests),
  failed: parseSqliteInteger(row.failedRequests),
  input: parseSqliteInteger(row.inputTokens),
  output: parseSqliteInteger(row.outputTokens),
  cost: parseSqliteInteger(row.cost),
  priced: parseSqliteInteger(row.priced ?? '0'),
  withUsage: parseSqliteInteger(row.withUsage ?? '0'),
});

const SUMS = `cast(count(*) as text) as requests,
      cast(count(case when termination_reason in ('failure', 'interrupted') then 1 end) as text) as failedRequests,
      cast(coalesce(sum(input_tokens), 0) as text) as inputTokens,
      cast(coalesce(sum(output_tokens), 0) as text) as outputTokens,
      cast(coalesce(sum(estimated_cost_nano_usd), 0) as text) as cost`;

/**
 * `usage_daily` has no Provider dimension, so the per-Provider split always reads root spans, as the
 * Dashboard's Provider health table does. Trace retention (45 days) covers the 30-day window.
 * Requests that never reached a Provider (`final_provider_id` null) have no Provider to count under.
 * Every column read here lives in `trace_span_root_usage_idx`, so the scan never touches the table. The
 * planner prefers the narrower `trace_span_root_ended_idx` on its own, hence `indexed by`; a column added
 * here must be added to the covering index too.
 *
 * One range scan per bucket, between the bucket starts (local midnights for day buckets): grouping a
 * month by a computed bucket would sort every row at once, which measured ~40% slower.
 */
function providerBucketTotals(
  db: BunSQLiteDatabase,
  range: ResolvedRange,
  starts: readonly number[],
): Map<string, Map<number, Totals>> {
  const sql = `select final_provider_id as providerId, ${SUMS}
    from trace_span indexed by trace_span_root_usage_idx
    where parent_span_id is null and final_provider_id is not null and ended_at >= ? and ended_at < ?
    group by final_provider_id`;
  const statement = (db as IterableDatabase).$client.query<RawAggregate & { providerId: string }, SQLQueryBindings[]>(
    sql,
  );
  const result = new Map<string, Map<number, Totals>>();
  starts.forEach((start, index) => {
    // The range end is inclusive; `+ 1` keeps a request ending exactly now.
    const end = starts[index + 1] ?? range.end.getTime() + 1;
    for (const row of statement.all(Math.max(start, range.start.getTime()), end)) {
      const buckets = result.get(row.providerId) ?? new Map<number, Totals>();
      buckets.set(index, toBigTotals(row));
      result.set(row.providerId, buckets);
    }
  });
  for (const row of consumedUsageRows(db, range.start, range.end)) {
    const index = starts.findLastIndex((start) => start <= row.endedAt);
    if (index < 0) continue;
    const buckets = result.get(row.usage.providerId) ?? new Map<number, Totals>();
    const totals = buckets.get(index) ?? emptyTotals();
    totals.input += row.inputTokens;
    totals.output += row.outputTokens;
    totals.cost += row.estimatedCostNanoUsd;
    buckets.set(index, totals);
    result.set(row.usage.providerId, buckets);
  }
  return result;
}

function merge(into: Totals, from: Totals): void {
  into.requests += from.requests;
  into.failed += from.failed;
  into.input += from.input;
  into.output += from.output;
  into.cost += from.cost;
  into.priced += from.priced;
  into.withUsage += from.withUsage;
}

function sumBuckets(buckets: ReadonlyMap<number, Totals>): Totals {
  const totals = emptyTotals();
  for (const bucket of buckets.values()) merge(totals, bucket);
  return totals;
}

/**
 * The previous 24h window as one aggregate instead of materialising every root row. `hasUsage` and
 * `priced` use the same definitions as `span-rows.ts`. Day ranges read `usage_daily` through
 * `rangeRows`, which is already cheap, so they do not come here.
 */
function previousHourTotals(db: BunSQLiteDatabase, range: ResolvedRange): Totals {
  const sql = `select ${SUMS},
      cast(count(estimated_cost_nano_usd) as text) as priced,
      cast(count(case when input_tokens is not null or output_tokens is not null or total_tokens is not null
        or cache_read_tokens is not null or cache_write_tokens is not null or reasoning_tokens is not null
        or estimated_cost_nano_usd is not null then 1 end) as text) as withUsage
    from trace_span
    where parent_span_id is null and ended_at >= ? and ended_at <= ?`;
  const statement = (db as IterableDatabase).$client.query<RawAggregate, SQLQueryBindings[]>(sql);
  const row = statement.get(range.start.getTime(), range.end.getTime());
  const totals = row === null ? emptyTotals() : toBigTotals(row);
  for (const row of consumedUsageRows(db, range.start, range.end)) {
    totals.input += row.inputTokens;
    totals.output += row.outputTokens;
    totals.cost += row.estimatedCostNanoUsd;
    totals.priced += BigInt(row.priced);
    totals.withUsage += BigInt(row.hasUsage);
  }
  return totals;
}

export function desktopUsage(db: BunSQLiteDatabase, query: DesktopUsageQuery): DesktopUsageResult {
  const now = query.now ?? new Date();
  const range = resolveRange(query.range, now);
  const rows = rangeRows(db, range);
  const previousRange = shiftRangeBack(range);

  const keys = bucketKeys(query.range, range.start, range.end);
  const bucketIndex = new Map(keys.map((key, index) => [key.identity, index]));
  const byBucket = keys.map(() => emptyTotals());
  const modelBuckets = new Map<string, Map<number, Totals>>();
  for (const row of rows) {
    const index = bucketIndex.get(row.bucket);
    if (index === undefined) continue;
    add(byBucket[index]!, row);
    const buckets = modelBuckets.get(row.dimension) ?? new Map<number, Totals>();
    const cell = buckets.get(index) ?? emptyTotals();
    add(cell, row);
    buckets.set(index, cell);
    modelBuckets.set(row.dimension, buckets);
  }
  const models = [...modelBuckets]
    .map(([modelId, buckets]): [string, Totals] => [modelId, sumBuckets(buckets)])
    .sort(byCostThenRequests)
    .slice(0, DESKTOP_USAGE_MAX_MODELS);
  const providerBuckets = providerBucketTotals(
    db,
    range,
    keys.map((key) => new Date(key.key).getTime()),
  );
  const providers = [...providerBuckets]
    .map(([providerId, buckets]): [string, Totals] => [providerId, sumBuckets(buckets)])
    .sort(byCostThenRequests);
  const cells = (buckets: ReadonlyMap<number, Totals> | undefined) =>
    [...(buckets ?? [])].sort(([a], [b]) => a - b).map(([bucket, totals]) => ({ bucket, ...toSlice(totals) }));

  return {
    range: query.range,
    bucketUnit: range.bucketUnit,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    current: toTotals(totalsOf(rows)),
    previous: toTotals(
      range.bucketUnit === 'hour' ? previousHourTotals(db, previousRange) : totalsOf(rangeRows(db, previousRange)),
    ),
    buckets: keys.map((key, index) => ({ start: key.key, ...toSlice(byBucket[index]!) })),
    byModel: models.map(([modelId, totals]) => ({ modelId, ...toSlice(totals) })),
    byProvider: providers.map(([providerId, totals]) => ({ providerId, ...toSlice(totals) })),
    trendByModel: models.flatMap(([modelId]) => cells(modelBuckets.get(modelId)).map((cell) => ({ ...cell, modelId }))),
    trendByProvider: providers.flatMap(([providerId]) =>
      cells(providerBuckets.get(providerId)).map((cell) => ({ ...cell, providerId })),
    ),
  };
}

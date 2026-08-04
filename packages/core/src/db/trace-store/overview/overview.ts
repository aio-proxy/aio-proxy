import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DashboardOverviewRange, DashboardOverviewResponse } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import type { DashboardOverviewQuery } from '../types';
import { aggregateRows, type ChartBucket, type OverviewRow } from '../usage-overview/aggregation';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

type RawRootRow = {
  readonly bucket: string | number;
  readonly dimension: string;
  readonly terminationReason: string | null;
  readonly requestCount: string;
  readonly hasUsage: string;
  readonly priced: string;
  readonly estimatedCostNanoUsd: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly totalTokens: string;
  readonly cacheReadTokens: string;
  readonly cacheWriteTokens: string;
  readonly normalizedCacheReadTokens: string;
  readonly normalizedPromptTokens: string;
};

type RootRow = OverviewRow & {
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly normalizedCacheReadTokens: bigint;
  readonly normalizedPromptTokens: bigint;
};

type RawHealthRow = {
  readonly providerId: string;
  readonly successCount: string;
  readonly attemptCount: string;
  readonly durations: string;
};

type RawCostRow = { readonly modelId: string; readonly estimatedCostNanoUsd: string };
type RawActivityRow = { readonly date: string; readonly requestCount: string };

export function overviewDashboard(db: BunSQLiteDatabase, query: DashboardOverviewQuery): DashboardOverviewResponse {
  const now = query.now ?? new Date();
  const range = resolveRange(query.range, now);
  const rows = rootRows(db, range);
  const chartBuckets = bucketKeys(query.range, range.start, range.end);
  const requests = aggregateRows(rows, 'requests', chartBuckets, 4);
  const tokens = aggregateRows(rows, 'tokens', chartBuckets, 4);
  const cost = aggregateRows(rows, 'cost', chartBuckets, 4);
  const summary = requests.summary;
  const cacheReadTokens = sum(rows, 'cacheReadTokens');
  const cacheWriteTokens = sum(rows, 'cacheWriteTokens');
  const normalizedCacheReadTokens = sum(rows, 'normalizedCacheReadTokens');
  const normalizedPromptTokens = sum(rows, 'normalizedPromptTokens');
  const elapsedMinutes = Math.max(1, (range.end.getTime() - range.start.getTime()) / 60_000);

  return {
    range: query.range,
    summary: {
      requestCount: summary.requestCount.toString(),
      totalTokens: summary.totalTokens.toString(),
      cacheReadTokens: cacheReadTokens.toString(),
      cacheWriteTokens: cacheWriteTokens.toString(),
      cacheHitRate: ratio(normalizedCacheReadTokens, normalizedPromptTokens),
      estimatedCostNanoUsd: summary.estimatedCostNanoUsd.toString(),
      averageRpm: Number(summary.requestCount) / elapsedMinutes,
      averageTpm: Number(summary.totalTokens) / elapsedMinutes,
      providerCount: 0,
    },
    modelTrendByMetric: {
      requests: modelTrend(requests),
      tokens: modelTrend(tokens),
      cost: modelTrend(cost),
    },
    providerHealth: providerHealth(db),
    topModelCosts: topModelCosts(db),
    activity: { year: query.year, days: activityDays(db, query.year) },
  };
}

function modelTrend(overview: ReturnType<typeof aggregateRows>) {
  const series = overview.series.filter(
    (entry): entry is Extract<(typeof overview.series)[number], { kind: 'dimension' | 'other' }> =>
      entry.kind === 'dimension' || entry.kind === 'other',
  );
  const keys = new Set(series.map(({ key }) => key));
  return {
    series,
    buckets: overview.buckets.map((bucket) => ({
      ...bucket,
      values: Object.fromEntries(Object.entries(bucket.values).filter(([key]) => keys.has(key))),
    })),
  };
}

function rootRows(db: BunSQLiteDatabase, range: ResolvedRange): readonly RootRow[] {
  const bucket =
    range.bucketUnit === 'hour'
      ? `min(23, cast((root.ended_at - ?) / 3600000 as integer))`
      : `strftime('%Y-%m-%d', root.ended_at / 1000, 'unixepoch', 'localtime')`;
  const sql = `
    select ${bucket} as bucket,
      coalesce(root.final_model_id, root.requested_model_id, 'unknown') as dimension,
      root.termination_reason as terminationReason,
      cast(count(*) as text) as requestCount,
      cast(sum(case when root.input_tokens is not null or root.output_tokens is not null
        or root.total_tokens is not null or root.cache_read_tokens is not null
        or root.cache_write_tokens is not null or root.reasoning_tokens is not null
        or root.estimated_cost_nano_usd is not null then 1 else 0 end) as text) as hasUsage,
      cast(sum(case when root.estimated_cost_nano_usd is not null then 1 else 0 end) as text) as priced,
      cast(sum(coalesce(root.estimated_cost_nano_usd, 0)) as text) as estimatedCostNanoUsd,
      cast(sum(coalesce(root.input_tokens, 0)) as text) as inputTokens,
      cast(sum(coalesce(root.output_tokens, 0)) as text) as outputTokens,
      cast(sum(coalesce(root.total_tokens,
        coalesce(root.input_tokens, 0) + coalesce(root.output_tokens, 0))) as text) as totalTokens,
      cast(sum(coalesce(root.cache_read_tokens, 0)) as text) as cacheReadTokens,
      cast(sum(coalesce(root.cache_write_tokens, 0)) as text) as cacheWriteTokens,
      cast(sum(case when attempt.transport in ('raw', 'ai_sdk')
        then coalesce(root.cache_read_tokens, 0) else 0 end) as text) as normalizedCacheReadTokens,
      cast(sum(case
        when attempt.transport = 'raw' and attempt.target_protocol = 'anthropic' then
          coalesce(root.input_tokens, 0) + coalesce(root.cache_read_tokens, 0) + coalesce(root.cache_write_tokens, 0)
        when attempt.transport in ('raw', 'ai_sdk') then
          max(coalesce(root.input_tokens, 0), coalesce(root.cache_read_tokens, 0) + coalesce(root.cache_write_tokens, 0))
        else 0 end) as text) as normalizedPromptTokens
    from trace_span root
    left join trace_span attempt on attempt.trace_id = root.trace_id
      and attempt.parent_span_id = root.span_id
      and attempt.name = 'aio_proxy.provider.attempt' and attempt.termination_reason is null
    where root.parent_span_id is null and root.ended_at >= ? and root.ended_at <= ?
    group by bucket, dimension, root.termination_reason`;
  const params = [
    ...(range.bucketUnit === 'hour' ? [range.start.getTime()] : []),
    range.start.getTime(),
    range.end.getTime(),
  ];
  return all<RawRootRow>(db, sql, params).map((row) => ({
    bucket: row.bucket,
    dimension: row.dimension,
    terminationReason: row.terminationReason,
    requestCount: parseSqliteInteger(row.requestCount),
    hasUsage: parseSqliteInteger(row.hasUsage),
    priced: parseSqliteInteger(row.priced),
    estimatedCostNanoUsd: parseSqliteInteger(row.estimatedCostNanoUsd),
    inputTokens: parseSqliteInteger(row.inputTokens),
    outputTokens: parseSqliteInteger(row.outputTokens),
    totalTokens: parseSqliteInteger(row.totalTokens),
    cacheReadTokens: parseSqliteInteger(row.cacheReadTokens),
    cacheWriteTokens: parseSqliteInteger(row.cacheWriteTokens),
    normalizedCacheReadTokens: parseSqliteInteger(row.normalizedCacheReadTokens),
    normalizedPromptTokens: parseSqliteInteger(row.normalizedPromptTokens),
  }));
}

function providerHealth(db: BunSQLiteDatabase): DashboardOverviewResponse['providerHealth'] {
  const rows = all<RawHealthRow>(
    db,
    `select provider_id as providerId,
      cast(sum(case when termination_reason is null then 1 else 0 end) as text) as successCount,
      cast(count(*) as text) as attemptCount,
      json_group_array(max(0, ended_at - started_at)) as durations
    from trace_span where name = 'aio_proxy.provider.attempt' and provider_id is not null
      group by provider_id order by provider_id`,
    [],
  );
  return rows.map((row) => {
    const durations = (JSON.parse(row.durations) as number[]).sort((left, right) => left - right);
    const successes = parseSqliteInteger(row.successCount);
    const attempts = parseSqliteInteger(row.attemptCount);
    return {
      providerId: row.providerId,
      successRate: Number(successes) / Number(attempts),
      p95LatencyMs: durations[Math.ceil(durations.length * 0.95) - 1]!,
    };
  });
}

function topModelCosts(db: BunSQLiteDatabase): DashboardOverviewResponse['topModelCosts'] {
  return all<RawCostRow>(
    db,
    `select coalesce(final_model_id, requested_model_id, 'unknown') as modelId,
      cast(sum(estimated_cost_nano_usd) as text) as estimatedCostNanoUsd
    from trace_span where parent_span_id is null and estimated_cost_nano_usd is not null
      group by modelId`,
    [],
  )
    .map((row) => ({ modelId: row.modelId, estimatedCostNanoUsd: parseSqliteInteger(row.estimatedCostNanoUsd) }))
    .sort(
      (left, right) =>
        compareBigIntDescending(left.estimatedCostNanoUsd, right.estimatedCostNanoUsd) ||
        left.modelId.localeCompare(right.modelId),
    )
    .slice(0, 5)
    .map((row) => ({ ...row, estimatedCostNanoUsd: row.estimatedCostNanoUsd.toString() }));
}

function activityDays(db: BunSQLiteDatabase, year: number): DashboardOverviewResponse['activity']['days'] {
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const counts = new Map(
    all<RawActivityRow>(
      db,
      `select strftime('%Y-%m-%d', ended_at / 1000, 'unixepoch', 'localtime') as date,
        cast(count(*) as text) as requestCount from trace_span
      where parent_span_id is null and ended_at >= ? and ended_at < ? group by date`,
      [start.getTime(), end.getTime()],
    ).map((row) => [row.date, parseSqliteInteger(row.requestCount).toString()] as const),
  );
  const days = [];
  for (const day = new Date(start); day < end; day.setDate(day.getDate() + 1)) {
    const date = localDate(day);
    days.push({ date, requestCount: counts.get(date) ?? '0' });
  }
  return days;
}

type ResolvedRange = ReturnType<typeof resolveRange>;

function resolveRange(range: DashboardOverviewRange, now: Date) {
  if (range === '24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, bucketUnit: 'hour' as const };
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end: now, bucketUnit: 'day' as const };
}

function bucketKeys(range: DashboardOverviewRange, start: Date, end: Date): readonly ChartBucket[] {
  if (range === '24h') {
    return Array.from({ length: 24 }, (_, index) => ({
      identity: index,
      key: new Date(start.getTime() + index * 60 * 60 * 1000).toISOString(),
    }));
  }
  const keys: ChartBucket[] = [];
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    keys.push({ identity: localDate(day), key: day.toISOString() });
  }
  return keys;
}

function all<T>(db: BunSQLiteDatabase, sql: string, params: readonly SQLQueryBindings[]): T[] {
  return (db as IterableDatabase).$client.query<T, SQLQueryBindings[]>(sql).all(...params);
}

function sum(rows: readonly RootRow[], key: keyof RootRow): bigint {
  return rows.reduce((total, row) => total + (row[key] as bigint), 0n);
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

const ratio = (numerator: bigint, denominator: bigint) =>
  denominator === 0n ? null : Number(numerator) / Number(denominator);
const compareBigIntDescending = (left: bigint, right: bigint) => (left === right ? 0 : left > right ? -1 : 1);

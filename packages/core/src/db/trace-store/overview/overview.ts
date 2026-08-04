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
  readonly transport: string | null;
  readonly targetProtocol: string | null;
  readonly hasUsage: number;
  readonly priced: number;
  readonly estimatedCostNanoUsd: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly totalTokens: string | null;
  readonly cacheReadTokens: string;
  readonly cacheWriteTokens: string;
};

type RootRow = OverviewRow & {
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly normalizedCacheReadTokens: bigint;
  readonly normalizedPromptTokens: bigint;
};

export function overviewDashboard(db: BunSQLiteDatabase, query: DashboardOverviewQuery): DashboardOverviewResponse {
  const now = query.now ?? new Date();
  const range = resolveRange(query.range, now);
  const rows = rootRows(db, range);
  const chartBuckets = bucketKeys(query.range, range.start, range.end);
  const requests = aggregateRows(
    rows.map((row) => ({ ...row, terminationReason: null })),
    'requests',
    chartBuckets,
    4,
  );
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
      attempt.transport as transport,
      attempt.target_protocol as targetProtocol,
      case when root.input_tokens is not null or root.output_tokens is not null
        or root.total_tokens is not null or root.cache_read_tokens is not null
        or root.cache_write_tokens is not null or root.reasoning_tokens is not null
        or root.estimated_cost_nano_usd is not null then 1 else 0 end as hasUsage,
      case when root.estimated_cost_nano_usd is not null then 1 else 0 end as priced,
      cast(coalesce(root.estimated_cost_nano_usd, 0) as text) as estimatedCostNanoUsd,
      cast(coalesce(root.input_tokens, 0) as text) as inputTokens,
      cast(coalesce(root.output_tokens, 0) as text) as outputTokens,
      cast(root.total_tokens as text) as totalTokens,
      cast(coalesce(root.cache_read_tokens, 0) as text) as cacheReadTokens,
      cast(coalesce(root.cache_write_tokens, 0) as text) as cacheWriteTokens
    from trace_span root
    left join trace_span attempt on attempt.trace_id = root.trace_id
      and attempt.parent_span_id = root.span_id
      and attempt.name = 'aio_proxy.provider.attempt' and attempt.termination_reason is null
    where root.parent_span_id is null and root.ended_at >= ? and root.ended_at <= ?`;
  const params = [
    ...(range.bucketUnit === 'hour' ? [range.start.getTime()] : []),
    range.start.getTime(),
    range.end.getTime(),
  ];
  return all<RawRootRow>(db, sql, params).map((row) => {
    const inputTokens = parseSqliteInteger(row.inputTokens);
    const outputTokens = parseSqliteInteger(row.outputTokens);
    const cacheReadTokens = parseSqliteInteger(row.cacheReadTokens);
    const cacheWriteTokens = parseSqliteInteger(row.cacheWriteTokens);
    const capturesCache = row.transport === 'raw' || row.transport === 'ai_sdk';
    const cachedTokens = cacheReadTokens + cacheWriteTokens;
    return {
      bucket: row.bucket,
      dimension: row.dimension,
      terminationReason: row.terminationReason,
      requestCount: 1n,
      hasUsage: row.hasUsage,
      priced: row.priced,
      estimatedCostNanoUsd: parseSqliteInteger(row.estimatedCostNanoUsd),
      inputTokens,
      outputTokens,
      totalTokens: row.totalTokens === null ? inputTokens + outputTokens : parseSqliteInteger(row.totalTokens),
      cacheReadTokens,
      cacheWriteTokens,
      normalizedCacheReadTokens: capturesCache ? cacheReadTokens : 0n,
      normalizedPromptTokens:
        row.transport === 'raw' && row.targetProtocol === 'anthropic'
          ? inputTokens + cachedTokens
          : capturesCache
            ? inputTokens > cachedTokens
              ? inputTokens
              : cachedTokens
            : 0n,
    };
  });
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

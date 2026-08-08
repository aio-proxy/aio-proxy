import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DashboardUsageOverviewResponse, UsageOverviewGroupBy, UsageOverviewRange } from '@aio-proxy/types';
import { and, gte, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { traceSpan } from '../../schema';
import type { UsageOverviewQuery } from '../types';
import { usageColumns } from '../usage-fields';
import { aggregateRows, type ChartBucket, type OverviewRow } from './aggregation';

type RawOverviewRow = Omit<OverviewRow, 'estimatedCostNanoUsd' | 'inputTokens' | 'outputTokens' | 'totalTokens'> & {
  readonly estimatedCostNanoUsd: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly totalTokens: string;
};

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

const requestTokens = sql`coalesce(
  ${traceSpan.totalTokens},
  coalesce(${traceSpan.inputTokens}, 0) + coalesce(${traceSpan.outputTokens}, 0)
)`;

const anyUsageColumn = sql.join(
  usageColumns.map((column) => sql`${column} is not null`),
  sql` or `,
);

export function overview(db: BunSQLiteDatabase, query: UsageOverviewQuery): DashboardUsageOverviewResponse {
  const now = query.now ?? new Date();
  const { start, end, bucketUnit } = resolveRange(query.range, now);
  const rangeFilter = and(gte(traceSpan.endedAt, start), lte(traceSpan.endedAt, end));
  const { summary, series, buckets } = aggregateRows(
    overviewRows(db, query.groupBy, bucketUnit, start, rangeFilter),
    query.metric,
    bucketKeys(query.range, start, end),
    query.maxResults,
    query.metric === 'requests' && query.groupBy === 'provider' && query.maxResults === undefined,
  );

  const elapsedMinutes = Math.max(1, (end.getTime() - start.getTime()) / 60_000);
  const successRate = ratio(summary.successCount, summary.successCount + summary.failureCount);
  const pricingCoverage = ratio(summary.pricedRequestCount, summary.usageRequestCount);

  return {
    range: query.range,
    metric: query.metric,
    groupBy: query.groupBy,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    bucketUnit,
    summary: {
      estimatedCostNanoUsd: summary.estimatedCostNanoUsd.toString(),
      pricingCoverage,
      pricedRequestCount: summary.pricedRequestCount.toString(),
      usageRequestCount: summary.usageRequestCount.toString(),
      requestCount: summary.requestCount.toString(),
      successCount: summary.successCount.toString(),
      failureCount: summary.failureCount.toString(),
      cancelledCount: summary.cancelledCount.toString(),
      successRate,
      inputTokens: summary.inputTokens.toString(),
      outputTokens: summary.outputTokens.toString(),
      totalTokens: summary.totalTokens.toString(),
      averageRpm: Number(summary.requestCount) / elapsedMinutes,
      averageTpm: Number(summary.totalTokens) / elapsedMinutes,
    },
    series,
    buckets,
  };
}

function resolveRange(range: UsageOverviewRange, now: Date) {
  if (range === '24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, bucketUnit: 'hour' as const };
  }
  const days = range === '7d' ? 7 : range === '14d' ? 14 : 30;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end: now, bucketUnit: 'day' as const };
}

function* overviewRows(
  db: BunSQLiteDatabase,
  groupBy: UsageOverviewGroupBy,
  bucketUnit: 'hour' | 'day',
  start: Date,
  rangeFilter: ReturnType<typeof and>,
): IterableIterator<OverviewRow> {
  const bucket =
    bucketUnit === 'hour'
      ? sql<number>`min(23, cast((${traceSpan.endedAt} - ${start.getTime()}) / 3600000 as integer))`.as('bucket')
      : sql<string>`strftime('%Y-%m-%d', ${traceSpan.endedAt} / 1000, 'unixepoch', 'localtime')`.as('bucket');
  const dimension = (
    groupBy === 'model'
      ? sql<string>`coalesce(${traceSpan.finalModelId}, ${traceSpan.requestedModelId}, 'unknown')`
      : sql<string>`coalesce(${traceSpan.finalProviderId}, 'unknown')`
  ).as('dimension');
  const query = db
    .select({
      bucket,
      dimension,
      terminationReason: sql<string | null>`${traceSpan.terminationReason}`.as('terminationReason'),
      hasUsage: sql<number>`case when ${anyUsageColumn} then 1 else 0 end`.as('hasUsage'),
      priced: sql<number>`case when ${traceSpan.estimatedCostNanoUsd} is not null then 1 else 0 end`.as('priced'),
      estimatedCostNanoUsd: sql<string>`cast(coalesce(${traceSpan.estimatedCostNanoUsd}, 0) as text)`.as(
        'estimatedCostNanoUsd',
      ),
      inputTokens: sql<string>`cast(coalesce(${traceSpan.inputTokens}, 0) as text)`.as('inputTokens'),
      outputTokens: sql<string>`cast(coalesce(${traceSpan.outputTokens}, 0) as text)`.as('outputTokens'),
      totalTokens: sql<string>`cast(${requestTokens} as text)`.as('totalTokens'),
    })
    .from(traceSpan)
    .where(and(isNull(traceSpan.parentSpanId), rangeFilter))
    .toSQL();
  const statement = (db as IterableDatabase).$client.query<RawOverviewRow, SQLQueryBindings[]>(query.sql);

  for (const row of statement.iterate(...(query.params as SQLQueryBindings[]))) {
    yield {
      ...row,
      estimatedCostNanoUsd: parseSqliteInteger(row.estimatedCostNanoUsd),
      inputTokens: parseSqliteInteger(row.inputTokens),
      outputTokens: parseSqliteInteger(row.outputTokens),
      totalTokens: parseSqliteInteger(row.totalTokens),
    };
  }
}

function bucketKeys(range: UsageOverviewRange, start: Date, end: Date): readonly ChartBucket[] {
  if (range === '24h') {
    return Array.from({ length: 24 }, (_, index) => ({
      identity: index,
      key: new Date(start.getTime() + index * 60 * 60 * 1000).toISOString(),
    }));
  }
  const keys: ChartBucket[] = [];
  const day = new Date(start);
  while (day <= end) {
    keys.push({ identity: localDate(day), key: day.toISOString() });
    day.setDate(day.getDate() + 1);
  }
  return keys;
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

const ratio = (numerator: bigint, denominator: bigint) =>
  denominator === 0n ? null : Number(numerator) / Number(denominator);

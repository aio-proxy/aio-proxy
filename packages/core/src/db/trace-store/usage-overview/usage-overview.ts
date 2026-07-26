import type {
  DashboardUsageOverviewResponse,
  UsageOverviewGroupBy,
  UsageOverviewMetric,
  UsageOverviewRange,
} from '@aio-proxy/types';
import { and, gte, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { traceSpan } from '../../schema';
import type { UsageOverviewQuery } from '../types';
import { usageColumns } from '../usage-fields';

type ChartRow = {
  readonly bucket: string | number;
  readonly dimension: string;
  readonly kind: 'dimension' | 'failed' | 'cancelled';
  readonly value: number;
};

type ChartBucket = {
  readonly identity: string | number;
  readonly key: string;
};

export function overview(db: BunSQLiteDatabase, query: UsageOverviewQuery): DashboardUsageOverviewResponse {
  const now = query.now ?? new Date();
  const { start, end, bucketUnit } = resolveRange(query.range, now);
  const rangeFilter = and(gte(traceSpan.endedAt, start), lte(traceSpan.endedAt, end));

  const anyUsageColumn = sql.join(
    usageColumns.map((column) => sql`${column} is not null`),
    sql` or `,
  );

  const summaryRow = db
    .select({
      estimatedCostUsd: sql<number>`coalesce(sum(${traceSpan.estimatedCostUsd}), 0)`.mapWith(Number),
      pricedRequestCount:
        sql<number>`coalesce(sum(case when ${traceSpan.estimatedCostUsd} is not null then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
      usageRequestCount: sql<number>`coalesce(sum(case when ${anyUsageColumn} then 1 else 0 end), 0)`.mapWith(Number),
      requestCount: sql<number>`count(*)`.mapWith(Number),
      successCount:
        sql<number>`coalesce(sum(case when ${traceSpan.terminationReason} is null then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
      failureCount:
        sql<number>`coalesce(sum(case when ${traceSpan.terminationReason} in ('failure','interrupted') then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
      cancelledCount:
        sql<number>`coalesce(sum(case when ${traceSpan.terminationReason} = 'cancelled' then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
      inputTokens: sql<number>`coalesce(sum(${traceSpan.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${traceSpan.outputTokens}), 0)`.mapWith(Number),
    })
    .from(traceSpan)
    .where(and(isNull(traceSpan.parentSpanId), rangeFilter))
    .get()!;

  const elapsedMinutes = Math.max(1, (end.getTime() - start.getTime()) / 60_000);
  const successRate =
    summaryRow.successCount + summaryRow.failureCount === 0
      ? null
      : summaryRow.successCount / (summaryRow.successCount + summaryRow.failureCount);
  const pricingCoverage =
    summaryRow.usageRequestCount === 0 ? null : summaryRow.pricedRequestCount / summaryRow.usageRequestCount;
  const totalTokens = summaryRow.inputTokens + summaryRow.outputTokens;

  const rows = chartRows(db, query.metric, query.groupBy, bucketUnit, start, rangeFilter);
  const { series, buckets } = buildChart(rows, query.metric, bucketKeys(query.range, start, end));

  return {
    range: query.range,
    metric: query.metric,
    groupBy: query.groupBy,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    bucketUnit,
    summary: {
      estimatedCostUsd: summaryRow.estimatedCostUsd,
      pricingCoverage,
      pricedRequestCount: summaryRow.pricedRequestCount,
      usageRequestCount: summaryRow.usageRequestCount,
      requestCount: summaryRow.requestCount,
      successCount: summaryRow.successCount,
      failureCount: summaryRow.failureCount,
      cancelledCount: summaryRow.cancelledCount,
      successRate,
      inputTokens: summaryRow.inputTokens,
      outputTokens: summaryRow.outputTokens,
      totalTokens,
      averageRpm: summaryRow.requestCount / elapsedMinutes,
      averageTpm: totalTokens / elapsedMinutes,
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

function chartRows(
  db: BunSQLiteDatabase,
  metric: UsageOverviewMetric,
  groupBy: UsageOverviewGroupBy,
  bucketUnit: 'hour' | 'day',
  start: Date,
  rangeFilter: ReturnType<typeof and>,
): readonly ChartRow[] {
  const bucket =
    bucketUnit === 'hour'
      ? sql<number>`min(23, cast((${traceSpan.endedAt} - ${start.getTime()}) / 3600000 as integer))`.mapWith(Number)
      : sql<string>`strftime('%Y-%m-%d', ${traceSpan.endedAt} / 1000, 'unixepoch', 'localtime')`;
  const normalDimension =
    groupBy === 'model'
      ? sql<string>`coalesce(${traceSpan.finalModelId}, ${traceSpan.requestedModelId}, 'unknown')`
      : sql<string>`coalesce(${traceSpan.finalProviderId}, 'unknown')`;

  if (metric === 'requests') {
    const kind = sql<ChartRow['kind']>`case
      when ${traceSpan.terminationReason} in ('failure','interrupted') then 'failed'
      when ${traceSpan.terminationReason} = 'cancelled' then 'cancelled'
      else 'dimension'
    end`;
    return db
      .select({ bucket, dimension: normalDimension, kind, value: sql<number>`count(*)`.mapWith(Number) })
      .from(traceSpan)
      .where(and(isNull(traceSpan.parentSpanId), rangeFilter))
      .groupBy(bucket, normalDimension, kind)
      .all();
  }

  const value =
    metric === 'cost'
      ? sql<number>`coalesce(sum(${traceSpan.estimatedCostUsd}), 0)`.mapWith(Number)
      : sql<number>`coalesce(sum(coalesce(${traceSpan.inputTokens}, 0) + coalesce(${traceSpan.outputTokens}, 0)), 0)`.mapWith(
          Number,
        );
  return db
    .select({ bucket, dimension: normalDimension, kind: sql<'dimension'>`'dimension'`, value })
    .from(traceSpan)
    .where(and(isNull(traceSpan.parentSpanId), rangeFilter, isNull(traceSpan.terminationReason)))
    .groupBy(bucket, normalDimension)
    .all();
}

function buildChart(rows: readonly ChartRow[], metric: UsageOverviewMetric, chartBuckets: readonly ChartBucket[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === 'dimension') {
      totals.set(row.dimension, (totals.get(row.dimension) ?? 0) + row.value);
    }
  }
  const ranked = [...totals]
    .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
    .map(([key]) => key);
  const retained = ranked.slice(0, 5);
  const hasOther = ranked.length > retained.length;
  const series = [
    ...retained.map((dimension) => ({ key: chartDimensionKey(dimension), kind: 'dimension' as const })),
    ...(hasOther ? [{ key: '__other__', kind: 'other' as const }] : []),
    ...(metric === 'requests'
      ? [
          { key: '__failed__', kind: 'failed' as const },
          { key: '__cancelled__', kind: 'cancelled' as const },
        ]
      : []),
  ];
  const retainedSet = new Set(retained);
  const valuesByBucket = new Map<string | number, Record<string, number>>();
  for (const row of rows) {
    const dimension =
      row.kind === 'failed'
        ? '__failed__'
        : row.kind === 'cancelled'
          ? '__cancelled__'
          : retainedSet.has(row.dimension)
            ? chartDimensionKey(row.dimension)
            : '__other__';
    const values = valuesByBucket.get(row.bucket) ?? {};
    values[dimension] = (values[dimension] ?? 0) + row.value;
    valuesByBucket.set(row.bucket, values);
  }

  return {
    series,
    buckets: chartBuckets.map(({ identity, key }) => ({
      key,
      values: Object.fromEntries(
        series.map(({ key: seriesKey }) => [seriesKey, valuesByBucket.get(identity)?.[seriesKey] ?? 0]),
      ),
    })),
  };
}

const dimensionKeyPrefix = 'dimension:';
const reservedSeriesKeys = new Set(['__failed__', '__cancelled__', '__other__']);

function chartDimensionKey(dimension: string): string {
  const needsEncoding =
    reservedSeriesKeys.has(dimension) ||
    dimension.startsWith(dimensionKeyPrefix) ||
    dimension.includes('.') ||
    dimension.includes('[') ||
    dimension.includes(']');
  return needsEncoding ? `${dimensionKeyPrefix}${encodeURIComponent(dimension).replaceAll('.', '%2E')}` : dimension;
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

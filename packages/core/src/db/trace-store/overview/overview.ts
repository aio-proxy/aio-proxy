import type { DashboardOverviewRange, DashboardOverviewResponse } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { DashboardOverviewQuery } from '../types';
import { aggregateRows, type ChartBucket } from '../usage-overview/aggregation';
import { dailyRows } from './daily-rows';
import { type ResolvedRange, resolveRange } from './range';
import { type RootRow, spanRows } from './span-rows';

export function overviewDashboard(db: BunSQLiteDatabase, query: DashboardOverviewQuery): DashboardOverviewResponse {
  const now = query.now ?? new Date();
  const range = resolveRange(query.range, now);
  const rows = rangeRows(db, range);
  const chartBuckets = bucketKeys(query.range, range.start, range.end);
  const requests = aggregateRows(
    rows.map((row) => ({ ...row, terminationReason: null })),
    'requests',
    chartBuckets,
    4,
  );
  const tokens = aggregateRows(rows, 'tokens', chartBuckets, 4);
  const cost = aggregateRows(rows, 'cost', chartBuckets, 4);
  const previousRange = shiftRangeBack(range);
  const current = summarize(rows, range);
  const previous = summarize(rangeRows(db, previousRange), previousRange);

  return {
    range: query.range,
    summary: {
      current: current.totals,
      previous: previous.totals,
      peakRpm: current.peakRpm,
      peakTpm: current.peakTpm,
      providerCount: 0,
    },
    modelTrendByMetric: {
      requests: modelTrend(requests),
      tokens: modelTrend(tokens),
      cost: modelTrend(cost),
    },
  };
}

/**
 * `trace_span` is pruned to a rolling retention window, so only the hour-bucketed
 * range can read it. Day ranges come from the `usage_daily` rollup, which is never
 * pruned and is the only source that reaches the longest range.
 */
function rangeRows(db: BunSQLiteDatabase, range: ResolvedRange): readonly RootRow[] {
  return range.bucketUnit === 'hour' ? spanRows(db, range) : dailyRows(db, range);
}

type SummaryTotals = {
  readonly requestCount: string;
  readonly totalTokens: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cacheReadTokens: string;
  readonly cacheWriteTokens: string;
  readonly cacheHitRate: number | null;
  readonly estimatedCostNanoUsd: string;
  readonly averageRpm: number;
  readonly averageTpm: number;
};

function summarize(
  rows: readonly RootRow[],
  range: ResolvedRange,
): {
  readonly totals: SummaryTotals;
  readonly peakRpm: number;
  readonly peakTpm: number;
} {
  const requestCount = sum(rows, 'requestCount');
  const totalTokens = sum(rows, 'totalTokens');
  const bucketMinutes = range.bucketUnit === 'hour' ? 60 : 1_440;
  const peaks = bucketPeaks(rows);
  // Rate over the time that actually has data, not the nominal window: an empty
  // tail (a range longer than the retained history) would otherwise deflate both
  // averages by the ratio of the two.
  const elapsedMinutes = Math.max(1, peaks.bucketCount * bucketMinutes);
  return {
    totals: {
      requestCount: requestCount.toString(),
      totalTokens: totalTokens.toString(),
      inputTokens: sum(rows, 'inputTokens').toString(),
      outputTokens: sum(rows, 'outputTokens').toString(),
      cacheReadTokens: sum(rows, 'cacheReadTokens').toString(),
      cacheWriteTokens: sum(rows, 'cacheWriteTokens').toString(),
      cacheHitRate: rows.some((row) => !row.cacheHitRateKnown)
        ? null
        : ratio(sum(rows, 'normalizedCacheReadTokens'), sum(rows, 'normalizedPromptTokens')),
      estimatedCostNanoUsd: sum(rows, 'estimatedCostNanoUsd').toString(),
      averageRpm: Number(requestCount) / elapsedMinutes,
      averageTpm: Number(totalTokens) / elapsedMinutes,
    },
    peakRpm: peaks.requests / bucketMinutes,
    peakTpm: peaks.tokens / bucketMinutes,
  };
}

// ponytail: day-range peaks are within-day averages, so a spiky day reads low.
// A real peak needs hourly rollups; add them if the peak note starts misleading.
function bucketPeaks(rows: readonly RootRow[]): {
  readonly requests: number;
  readonly tokens: number;
  readonly bucketCount: number;
} {
  const requestsByBucket = new Map<string | number, number>();
  const tokensByBucket = new Map<string | number, number>();
  for (const row of rows) {
    const requestCount = Number(row.requestCount ?? 1n);
    requestsByBucket.set(row.bucket, (requestsByBucket.get(row.bucket) ?? 0) + requestCount);
    tokensByBucket.set(row.bucket, (tokensByBucket.get(row.bucket) ?? 0) + Number(row.totalTokens));
  }
  return {
    requests: Math.max(0, ...requestsByBucket.values()),
    tokens: Math.max(0, ...tokensByBucket.values()),
    bucketCount: requestsByBucket.size,
  };
}

/**
 * Day ranges start at midnight but end partway through today, so shifting by the
 * millisecond span would land the previous window mid-day and `dailyRows()` would
 * round it back up to a whole day, double-counting the boundary. Step whole
 * calendar days instead so the two windows are disjoint and equally sized.
 */
function shiftRangeBack(range: ResolvedRange): ResolvedRange {
  if (range.bucketUnit === 'hour') {
    const span = range.end.getTime() - range.start.getTime();
    return { start: new Date(range.start.getTime() - span), end: new Date(range.start.getTime()), bucketUnit: 'hour' };
  }
  const end = new Date(range.start);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (dayCount(range) - 1));
  return { start, end, bucketUnit: 'day' };
}

/** Inclusive calendar-day width of a day range, both endpoints normalized to midnight. */
function dayCount(range: ResolvedRange): number {
  const end = new Date(range.end);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - range.start.getTime()) / 86_400_000) + 1;
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

function sum(rows: readonly RootRow[], key: keyof RootRow): bigint {
  return rows.reduce((total, row) => total + ((row[key] ?? 0n) as bigint), 0n);
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

const ratio = (numerator: bigint, denominator: bigint) =>
  denominator === 0n ? null : Number(numerator) / Number(denominator);

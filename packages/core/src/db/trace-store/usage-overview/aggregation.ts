import type { UsageOverviewMetric } from '@aio-proxy/types';

export type OverviewRow = {
  readonly bucket: string | number;
  readonly dimension: string;
  readonly terminationReason: string | null;
  readonly hasUsage: number | bigint;
  readonly priced: number | bigint;
  readonly estimatedCostNanoUsd: bigint;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly totalTokens: bigint;
  readonly requestCount?: bigint;
};

export type ChartBucket = {
  readonly identity: string | number;
  readonly key: string;
};

type BucketValues = {
  readonly dimensions: Map<string, bigint>;
  failed: bigint;
  cancelled: bigint;
};

export function aggregateRows(
  rows: Iterable<OverviewRow>,
  metric: UsageOverviewMetric,
  chartBuckets: readonly ChartBucket[],
  retainedDimensionCount = 5,
) {
  const summary = emptySummary();
  const totals = new Map<string, bigint>();
  const valuesByBucket = new Map<string | number, BucketValues>();
  for (const row of rows) {
    addSummary(summary, row);
    if (metric !== 'requests' && row.terminationReason !== null) continue;

    const value =
      metric === 'requests' ? (row.requestCount ?? 1n) : metric === 'cost' ? row.estimatedCostNanoUsd : row.totalTokens;
    const kind =
      row.terminationReason === 'failure' || row.terminationReason === 'interrupted'
        ? 'failed'
        : row.terminationReason === 'cancelled'
          ? 'cancelled'
          : 'dimension';
    const bucket = valuesByBucket.get(row.bucket) ?? { dimensions: new Map(), failed: 0n, cancelled: 0n };
    if (kind === 'dimension') {
      totals.set(row.dimension, (totals.get(row.dimension) ?? 0n) + value);
      bucket.dimensions.set(row.dimension, (bucket.dimensions.get(row.dimension) ?? 0n) + value);
    } else {
      bucket[kind] += value;
    }
    valuesByBucket.set(row.bucket, bucket);
  }
  return { summary, ...buildChart(totals, valuesByBucket, metric, chartBuckets, retainedDimensionCount) };
}

function emptySummary() {
  return {
    estimatedCostNanoUsd: 0n,
    pricedRequestCount: 0n,
    usageRequestCount: 0n,
    requestCount: 0n,
    successCount: 0n,
    failureCount: 0n,
    cancelledCount: 0n,
    inputTokens: 0n,
    outputTokens: 0n,
    totalTokens: 0n,
  };
}

function addSummary(summary: ReturnType<typeof emptySummary>, row: OverviewRow): void {
  const requestCount = row.requestCount ?? 1n;
  summary.estimatedCostNanoUsd += row.estimatedCostNanoUsd;
  summary.pricedRequestCount += BigInt(row.priced);
  summary.usageRequestCount += BigInt(row.hasUsage);
  summary.requestCount += requestCount;
  if (row.terminationReason === null) summary.successCount += requestCount;
  if (row.terminationReason === 'failure' || row.terminationReason === 'interrupted')
    summary.failureCount += requestCount;
  if (row.terminationReason === 'cancelled') summary.cancelledCount += requestCount;
  summary.inputTokens += row.inputTokens;
  summary.outputTokens += row.outputTokens;
  summary.totalTokens += row.totalTokens;
}

function buildChart(
  totals: ReadonlyMap<string, bigint>,
  valuesByBucket: ReadonlyMap<string | number, BucketValues>,
  metric: UsageOverviewMetric,
  chartBuckets: readonly ChartBucket[],
  retainedDimensionCount: number,
) {
  const ranked = [...totals]
    .sort(
      ([leftKey, left], [rightKey, right]) => compareBigIntDescending(left, right) || leftKey.localeCompare(rightKey),
    )
    .map(([key]) => key);
  const retained = ranked.slice(0, retainedDimensionCount);
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
  return {
    series,
    buckets: chartBuckets.map(({ identity, key }) => ({
      key,
      values: bucketValues(valuesByBucket.get(identity), series, retainedSet),
    })),
  };
}

function bucketValues(
  bucket: BucketValues | undefined,
  series: readonly { readonly key: string }[],
  retained: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const values = new Map<string, bigint>(series.map(({ key }) => [key, 0n]));
  if (bucket !== undefined) {
    for (const [dimension, value] of bucket.dimensions) {
      const key = retained.has(dimension) ? chartDimensionKey(dimension) : '__other__';
      values.set(key, (values.get(key) ?? 0n) + value);
    }
    if (values.has('__failed__')) values.set('__failed__', bucket.failed);
    if (values.has('__cancelled__')) values.set('__cancelled__', bucket.cancelled);
  }
  return Object.fromEntries([...values].map(([key, value]) => [key, value.toString()]));
}

const compareBigIntDescending = (left: bigint, right: bigint) => (left === right ? 0 : left > right ? -1 : 1);

const dimensionKeyPrefix = 'dimension:';
const reservedSeriesKeys = new Set(['__failed__', '__cancelled__', '__other__', '__proto__']);

function chartDimensionKey(dimension: string): string {
  const needsEncoding =
    reservedSeriesKeys.has(dimension) ||
    dimension.startsWith(dimensionKeyPrefix) ||
    dimension.includes('.') ||
    dimension.includes('[') ||
    dimension.includes(']');
  return needsEncoding ? `${dimensionKeyPrefix}${encodeURIComponent(dimension).replaceAll('.', '%2E')}` : dimension;
}

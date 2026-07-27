import { describe, expect, test } from '@rstest/core';
import { createStore } from 'jotai';

import { toUsageChartData } from '../components/usage-trend-chart';
import { decodeUsageOverview, usageQueryOptions } from '../services/usage-service';
import { createUsageValueFormatter, formatNanoUsd } from '../services/usage-value-formatter';
import { usageOverviewFiltersAtom } from '../stores/usage-overview-filters';

const usageWire = {
  range: '24h' as const,
  metric: 'tokens' as const,
  groupBy: 'model' as const,
  rangeStart: '2026-07-26T00:00:00.000Z',
  rangeEnd: '2026-07-27T00:00:00.000Z',
  bucketUnit: 'hour' as const,
  summary: {
    estimatedCostNanoUsd: '9007199254740993',
    pricingCoverage: 0.5,
    pricedRequestCount: '6',
    usageRequestCount: '12',
    requestCount: '12',
    successCount: '10',
    failureCount: '1',
    cancelledCount: '1',
    successRate: 10 / 11,
    inputTokens: '4503599627370496',
    outputTokens: '4503599627370497',
    totalTokens: '9007199254740993',
    averageRpm: 0.5,
    averageTpm: 375_299_968_947_541.4,
  },
  series: [{ key: 'model', kind: 'dimension' as const }],
  buckets: [{ key: '2026-07-26T00:00:00.000Z', values: { model: '9007199254740993' } }],
};

describe('usage overview', () => {
  test('decodes aggregate decimal strings as bigint without changing rate fields', () => {
    const decoded = decodeUsageOverview(usageWire);

    expect(decoded.summary.totalTokens).toBe(9_007_199_254_740_993n);
    expect(decoded.summary.requestCount).toBe(12n);
    expect(decoded.buckets[0]?.values['model']).toBe(9_007_199_254_740_993n);
    expect(decoded.summary.averageTpm).toBe(usageWire.summary.averageTpm);
  });

  test('formats nano-USD without crossing the Number precision boundary', () => {
    expect(formatNanoUsd(2n, 'en-US')).toBe('$0.000000002');
    expect(formatNanoUsd(9_007_199_254_740_993_000_000_002n, 'en-US')).toBe('$9,007,199,254,740,993.000000002');
  });

  test('converts bigint buckets to numbers only at the chart boundary', () => {
    const cost = decodeUsageOverview({
      ...usageWire,
      metric: 'cost',
      buckets: [{ ...usageWire.buckets[0], values: { model: '2000000000' } }],
    });
    const tokens = decodeUsageOverview(usageWire);
    const requests = decodeUsageOverview({
      ...usageWire,
      metric: 'requests',
      buckets: [{ ...usageWire.buckets[0], values: { model: '12' } }],
    });

    expect(toUsageChartData(cost)).toEqual([{ bucket: usageWire.buckets[0].key, model: 2 }]);
    expect(toUsageChartData(tokens)).toEqual([{ bucket: usageWire.buckets[0].key, model: 9_007_199_254_740_992 }]);
    expect(toUsageChartData(requests)).toEqual([{ bucket: usageWire.buckets[0].key, model: 12 }]);
  });

  test('keys cache and polling by all selected controls', () => {
    const options = usageQueryOptions({ range: '7d', metric: 'tokens', groupBy: 'provider' });

    expect(options.queryKey).toEqual(['dashboard', 'usage', '7d', 'tokens', 'provider']);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  test('stores all overview filters in one Jotai atom', () => {
    const store = createStore();

    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: '24h', metric: 'cost', groupBy: 'model' });
    store.set(usageOverviewFiltersAtom, (current) => ({ ...current, metric: 'requests', groupBy: 'provider' }));
    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: '24h', metric: 'requests', groupBy: 'provider' });
  });

  test('preserves meaningful USD precision without compacting cost', () => {
    const formatCost = createUsageValueFormatter('cost', 'en-US');

    expect(formatCost(0.0049)).toBe('$0.0049');
    expect(formatCost(12_345.67)).toBe('$12,345.67');
  });

  test('formats token and request metrics as compact integers', () => {
    const formatTokens = createUsageValueFormatter('tokens', 'en-US');
    const formatRequests = createUsageValueFormatter('requests', 'en-US');

    expect(formatTokens(1_200)).toBe('1.2K');
    expect(formatRequests(1_234_567)).toBe('1M');
  });
});

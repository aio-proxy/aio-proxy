import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { createStore } from 'jotai';

import { toUsageChartData } from '../components/usage-trend-chart';
import { decodeUsageOverview, getUsage, usageQueryOptions } from '../services/usage-service';
import { usageOverviewFiltersAtom } from '../stores/usage-overview-filters';

const mocks = rs.hoisted(() => ({ usage: rs.fn() }));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: { dashboard: { api: { usage: { $get: mocks.usage } } } },
}));

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
  beforeEach(() => {
    mocks.usage.mockReset();
    mocks.usage.mockResolvedValue(Response.json(usageWire));
  });

  test('decodes aggregate decimal strings as bigint without changing rate fields', () => {
    const decoded = decodeUsageOverview(usageWire);

    expect(decoded.summary.totalTokens).toBe(9_007_199_254_740_993n);
    expect(decoded.summary.requestCount).toBe(12n);
    expect(decoded.buckets[0]?.values['model']).toBe(9_007_199_254_740_993n);
    expect(decoded.summary.averageTpm).toBe(usageWire.summary.averageTpm);
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

  test('limits regular Usage requests to the top five dimensions', async () => {
    await getUsage({ range: '7d', metric: 'tokens', groupBy: 'provider' });

    expect(mocks.usage).toHaveBeenCalledWith({
      query: { range: '7d', metric: 'tokens', groupBy: 'provider', maxResults: 5 },
    });
  });

  test('stores all overview filters in one Jotai atom', () => {
    const store = createStore();

    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: '24h', metric: 'cost', groupBy: 'model' });
    store.set(usageOverviewFiltersAtom, (current) => ({ ...current, metric: 'requests', groupBy: 'provider' }));
    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: '24h', metric: 'requests', groupBy: 'provider' });
  });
});

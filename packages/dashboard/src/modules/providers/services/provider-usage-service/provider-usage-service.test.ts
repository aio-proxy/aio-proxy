import { beforeEach, describe, expect, rs, test } from '@rstest/core';

import { getProviderUsage, providerUsageQueryOptions } from '.';

const mocks = rs.hoisted(() => ({ usageGet: rs.fn() }));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: { dashboard: { api: { usage: { $get: mocks.usageGet } } } },
}));

const usageResponse = (metric: 'cost' | 'requests' | 'tokens', values: readonly Record<string, string>[] = [{}, {}]) =>
  Response.json({
    range: '24h',
    metric,
    groupBy: 'provider',
    rangeStart: '2026-08-07T00:00:00.000Z',
    rangeEnd: '2026-08-08T00:00:00.000Z',
    bucketUnit: 'hour',
    summary: {
      estimatedCostNanoUsd: '0',
      pricedRequestCount: '0',
      usageRequestCount: '0',
      requestCount: '0',
      successCount: '0',
      failureCount: '0',
      cancelledCount: '0',
      successRate: null,
      inputTokens: '0',
      outputTokens: '0',
      totalTokens: '0',
      averageRpm: 0,
      averageTpm: 0,
    },
    series: [{ key: 'dimension:openai%2Emain', kind: 'dimension' }],
    buckets: [
      { key: '2026-08-07T00:00:00.000Z', values: values[0] ?? {} },
      { key: '2026-08-07T01:00:00.000Z', values: values[1] ?? {} },
    ],
  });

describe('Provider usage service', () => {
  beforeEach(() => mocks.usageGet.mockReset());

  test('totals decoded Provider dimensions across every metric bucket', async () => {
    mocks.usageGet
      .mockResolvedValueOnce(
        usageResponse('requests', [{ 'dimension:openai%2Emain': '1' }, { 'dimension:openai%2Emain': '2' }]),
      )
      .mockResolvedValueOnce(
        usageResponse('tokens', [{ 'dimension:openai%2Emain': '40' }, { 'dimension:openai%2Emain': '80' }]),
      )
      .mockResolvedValueOnce(
        usageResponse('cost', [{ 'dimension:openai%2Emain': '3' }, { 'dimension:openai%2Emain': '6' }]),
      );

    expect(await getProviderUsage()).toEqual(
      new Map([['openai.main', { requestCount: 3n, totalTokens: 120n, estimatedCostNanoUsd: 9n }]]),
    );
    expect(mocks.usageGet).toHaveBeenCalledWith({
      query: { range: '24h', metric: 'requests', groupBy: 'provider' },
    });
    expect(mocks.usageGet).toHaveBeenCalledTimes(3);
    expect(providerUsageQueryOptions()).toMatchObject({
      queryKey: ['dashboard', 'usage', '24h', 'requests', 'provider', undefined],
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    });
  });

  test('rejects a failed usage response', async () => {
    mocks.usageGet.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(getProviderUsage()).rejects.toMatchObject({
      name: 'DashboardUsageRequestError',
      status: 503,
    });
  });
});

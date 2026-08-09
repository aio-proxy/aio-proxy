import { beforeEach, describe, expect, rs, test } from '@rstest/core';

import { queryKeys } from '@/lib/query-keys';

import { getProviderUsage, providerUsageQueryOptions } from '.';

const mocks = rs.hoisted(() => ({ usageGet: rs.fn() }));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: { dashboard: { api: { usage: { $get: mocks.usageGet } } } },
}));

const usageResponse = (values: readonly Record<string, string>[] = [{}, {}]) =>
  Response.json({
    range: '24h',
    metric: 'requests',
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
    series: [
      { key: 'dimension:openai%2Emain', kind: 'dimension' },
      { key: 'dimension:anthropic%2Ebackup', kind: 'dimension' },
      { key: 'openai-main', kind: 'dimension' },
    ],
    buckets: [
      { key: '2026-08-07T00:00:00.000Z', values: values[0] ?? {} },
      { key: '2026-08-07T01:00:00.000Z', values: values[1] ?? {} },
    ],
  });

describe('Provider usage service', () => {
  beforeEach(() => mocks.usageGet.mockReset());

  test('totals decoded Provider request dimensions across every bucket', async () => {
    mocks.usageGet.mockResolvedValue(
      usageResponse([
        { 'dimension:openai%2Emain': '1', 'dimension:anthropic%2Ebackup': '7' },
        { 'dimension:openai%2Emain': '2', 'openai-main': '4' },
      ]),
    );

    expect(await getProviderUsage()).toEqual(
      new Map([
        ['openai.main', { requestCount: 3n }],
        ['anthropic.backup', { requestCount: 7n }],
        ['openai-main', { requestCount: 4n }],
      ]),
    );
    expect(mocks.usageGet).toHaveBeenCalledWith({
      query: { range: '24h', metric: 'requests', groupBy: 'provider' },
    });
    expect(mocks.usageGet).toHaveBeenCalledTimes(1);
    expect(providerUsageQueryOptions()).toMatchObject({
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    });
    expect(providerUsageQueryOptions().queryKey).not.toEqual(queryKeys.usage('24h', 'requests', 'provider'));
  });

  test('rejects a failed usage response', async () => {
    mocks.usageGet.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(getProviderUsage()).rejects.toMatchObject({
      name: 'DashboardUsageRequestError',
      status: 503,
    });
  });
});

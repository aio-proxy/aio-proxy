import { describe, expect, test } from '@rstest/core';

import { decodeOverview, overviewQueryOptions } from './overview-service';

const wireOverview = {
  range: '24h' as const,
  summary: {
    requestCount: '11',
    totalTokens: '22',
    cacheReadTokens: '3',
    cacheWriteTokens: '4',
    cacheHitRate: 0.5,
    estimatedCostNanoUsd: '500',
    averageRpm: 1.5,
    averageTpm: 2.5,
    providerCount: 2,
  },
  modelTrendByMetric: {
    requests: { series: [{ key: 'model-a', kind: 'dimension' as const }], buckets: [{ key: 'a', values: { a: '1' } }] },
    tokens: { series: [{ key: 'model-a', kind: 'dimension' as const }], buckets: [{ key: 'b', values: { a: '2' } }] },
    cost: { series: [{ key: 'model-a', kind: 'dimension' as const }], buckets: [{ key: 'c', values: { a: '3' } }] },
  },
  providerHealth: [{ providerId: 'first', successRate: 1, p95LatencyMs: 25 }],
  topModelCosts: [{ modelId: 'model-a', estimatedCostNanoUsd: '600' }],
  activity: { year: 2026, days: [{ date: '2026-01-01', requestCount: '7' }] },
};

describe('overview service', () => {
  test('decodes every overview integer string to bigint', () => {
    const overview = decodeOverview(wireOverview);

    expect(overview.summary).toMatchObject({
      requestCount: 11n,
      totalTokens: 22n,
      cacheReadTokens: 3n,
      cacheWriteTokens: 4n,
      estimatedCostNanoUsd: 500n,
    });
    expect(overview.modelTrendByMetric.requests.buckets[0]?.values).toEqual({ a: 1n });
    expect(overview.modelTrendByMetric.tokens.buckets[0]?.values).toEqual({ a: 2n });
    expect(overview.modelTrendByMetric.cost.buckets[0]?.values).toEqual({ a: 3n });
    expect(overview.topModelCosts[0]?.estimatedCostNanoUsd).toBe(600n);
    expect(overview.activity.days[0]?.requestCount).toBe(7n);
  });

  test('polls only the 24h range and keeps local metric selection out of the key', () => {
    expect(overviewQueryOptions({ range: '24h', year: 2026 })).toMatchObject({
      queryKey: ['dashboard', 'overview', '24h', 2026],
      refetchInterval: 5_000,
    });
    expect(overviewQueryOptions({ range: '90d', year: 2026 })).toMatchObject({
      queryKey: ['dashboard', 'overview', '90d', 2026],
      refetchInterval: false,
    });
  });

  test('retains the previous overview while a changed range or year is loading', () => {
    const previous = decodeOverview(wireOverview);
    const placeholder = overviewQueryOptions({ range: '7d', year: 2025 }).placeholderData;

    expect(typeof placeholder).toBe('function');
    if (typeof placeholder !== 'function') throw new Error('Expected functional placeholder data');
    expect(placeholder(previous, undefined as never)).toBe(previous);
  });
});

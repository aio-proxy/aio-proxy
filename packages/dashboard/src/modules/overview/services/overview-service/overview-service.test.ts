import { describe, expect, test } from '@rstest/core';

import {
  decodeOverview,
  decodeOverviewActivity,
  decodeOverviewDiagnostics,
  overviewActivityQueryOptions,
  overviewDiagnosticsQueryOptions,
  overviewQueryOptions,
} from './overview-service';

const wireOverview = {
  range: '24h' as const,
  summary: {
    current: {
      requestCount: '11',
      totalTokens: '22',
      inputTokens: '15',
      outputTokens: '7',
      cacheReadTokens: '3',
      cacheWriteTokens: '4',
      cacheHitRate: 0.5,
      estimatedCostNanoUsd: '500',
      averageRpm: 1.5,
      averageTpm: 2.5,
    },
    previous: {
      requestCount: '8',
      totalTokens: '16',
      inputTokens: '10',
      outputTokens: '6',
      cacheReadTokens: '2',
      cacheWriteTokens: '2',
      cacheHitRate: 0.4,
      estimatedCostNanoUsd: '400',
      averageRpm: 1,
      averageTpm: 2,
    },
    peakRpm: 3,
    peakTpm: 5,
    providerCount: 2,
  },
  modelTrendByMetric: {
    requests: { series: [{ key: 'model-a', kind: 'dimension' as const }], buckets: [{ key: 'a', values: { a: '1' } }] },
    tokens: { series: [{ key: 'model-a', kind: 'dimension' as const }], buckets: [{ key: 'b', values: { a: '2' } }] },
    cost: { series: [{ key: 'model-a', kind: 'dimension' as const }], buckets: [{ key: 'c', values: { a: '3' } }] },
  },
};

const wireDiagnostics = {
  providerHealth: [{ providerId: 'first', successRate: 1, p95LatencyMs: 25, totalTokens: '0' }],
  topModelCosts: [{ modelId: 'model-a', estimatedCostNanoUsd: '600' }],
};

const wireActivity = {
  from: '2025-08-10',
  to: '2026-08-05',
  items: [{ date: '2026-01-01', totalTokens: '7', models: [{ modelId: 'model-a', totalTokens: '7' }] }],
};

describe('overview service', () => {
  test('decodes integer strings from every overview source to bigint', () => {
    const overview = decodeOverview(wireOverview);
    const diagnostics = decodeOverviewDiagnostics(wireDiagnostics);
    const activity = decodeOverviewActivity(wireActivity);

    expect(overview.summary.current).toMatchObject({
      requestCount: 11n,
      totalTokens: 22n,
      cacheReadTokens: 3n,
      cacheWriteTokens: 4n,
      estimatedCostNanoUsd: 500n,
    });
    expect(overview.summary.previous).toMatchObject({ requestCount: 8n, totalTokens: 16n });
    expect(overview.modelTrendByMetric.requests.buckets[0]?.values).toEqual({ a: 1n });
    expect(overview.modelTrendByMetric.tokens.buckets[0]?.values).toEqual({ a: 2n });
    expect(overview.modelTrendByMetric.cost.buckets[0]?.values).toEqual({ a: 3n });
    expect(diagnostics.topModelCosts[0]?.estimatedCostNanoUsd).toBe(600n);
    expect(activity.items[0]).toMatchObject({
      totalTokens: 7n,
      models: [{ modelId: 'model-a', totalTokens: 7n }],
    });
  });

  test('polls only successful 24h range data while diagnostics follow the range and activity stays independent', () => {
    const liveOverview = overviewQueryOptions({ range: '24h' });
    expect(liveOverview).toMatchObject({
      queryKey: ['dashboard', 'overview', 'range', '24h'],
    });
    expect(liveOverview.refetchInterval).toBeTypeOf('function');
    if (typeof liveOverview.refetchInterval !== 'function') throw new Error('Expected conditional polling');
    expect(liveOverview.refetchInterval({ state: { status: 'success' } } as never)).toBe(5_000);
    expect(liveOverview.refetchInterval({ state: { status: 'error' } } as never)).toBe(false);
    expect(overviewQueryOptions({ range: '90d' })).toMatchObject({
      queryKey: ['dashboard', 'overview', 'range', '90d'],
      refetchInterval: false,
    });
    expect(overviewDiagnosticsQueryOptions({ range: '24h' })).toMatchObject({
      queryKey: ['dashboard', 'overview', 'diagnostics', '24h'],
      refetchInterval: 5_000,
      staleTime: 60_000,
    });
    expect(overviewDiagnosticsQueryOptions({ range: '90d' })).toMatchObject({
      queryKey: ['dashboard', 'overview', 'diagnostics', '90d'],
      refetchInterval: false,
    });
    expect(overviewActivityQueryOptions()).toMatchObject({
      queryKey: ['dashboard', 'overview', 'activity'],
      refetchInterval: false,
      staleTime: 60_000,
    });
  });

  test('retains only the previous source while range data is loading', () => {
    const previous = decodeOverview(wireOverview);
    const previousActivity = decodeOverviewActivity(wireActivity);
    const rangePlaceholder = overviewQueryOptions({ range: '7d' }).placeholderData;
    const activityPlaceholder = overviewActivityQueryOptions().placeholderData;

    expect(typeof rangePlaceholder).toBe('function');
    expect(typeof activityPlaceholder).toBe('function');
    if (typeof rangePlaceholder !== 'function' || typeof activityPlaceholder !== 'function') {
      throw new Error('Expected functional placeholder data');
    }
    expect(rangePlaceholder(previous, undefined as never)).toBe(previous);
    expect(activityPlaceholder(previousActivity, undefined as never)).toBe(previousActivity);
  });
});

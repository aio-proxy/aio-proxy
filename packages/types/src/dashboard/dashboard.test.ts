import { expect, test } from 'bun:test';

import { DashboardOverviewRangeSchema, UsageOverviewRangeSchema } from '../usage';
import { DashboardOverviewResponseSchema } from './dashboard';

const overviewInput = {
  range: '90d',
  summary: {
    requestCount: '1',
    totalTokens: '2',
    cacheReadTokens: '1',
    cacheWriteTokens: '0',
    cacheHitRate: 0.5,
    estimatedCostNanoUsd: '0',
    averageRpm: 1,
    averageTpm: 2,
    providerCount: 1,
  },
  modelTrendByMetric: {
    requests: { buckets: [], series: [] },
    tokens: { buckets: [], series: [] },
    cost: { buckets: [], series: [] },
  },
  providerHealth: [{ providerId: 'openai-main', successRate: 1, p95LatencyMs: 42 }],
  topModelCosts: [{ modelId: 'gpt-4.1', estimatedCostNanoUsd: '4' }],
  activity: { year: 2026, days: [{ date: '2026-01-01', requestCount: '1' }] },
} as const;

test('accepts an overview with a 90-day window and a complete yearly activity series', () => {
  const value = DashboardOverviewResponseSchema.parse(overviewInput);

  expect(value.range).toBe('90d');
});

test('rejects request outcome series from the model-only overview trend', () => {
  const result = DashboardOverviewResponseSchema.safeParse({
    ...overviewInput,
    modelTrendByMetric: {
      ...overviewInput.modelTrendByMetric,
      requests: { buckets: [], series: [{ key: '__failed__', kind: 'failed' }] },
    },
  });

  expect(result.success).toBe(false);
});

test('keeps the legacy usage range independent from overview ranges', () => {
  expect(UsageOverviewRangeSchema.safeParse('14d').success).toBe(true);
  expect(UsageOverviewRangeSchema.safeParse('90d').success).toBe(false);
  expect(DashboardOverviewRangeSchema.safeParse('90d').success).toBe(true);
  expect(DashboardOverviewRangeSchema.safeParse('14d').success).toBe(false);
});

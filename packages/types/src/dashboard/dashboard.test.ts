import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '../provider';
import { DashboardOverviewRangeSchema, UsageOverviewRangeSchema } from '../usage';
import {
  DashboardOverviewActivityResponseSchema,
  DashboardOverviewDiagnosticsResponseSchema,
  DashboardOverviewResponseSchema,
  DashboardProviderSummarySchema,
} from './dashboard';

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
} as const;

const diagnosticsInput = {
  providerHealth: [{ providerId: 'openai-main', successRate: 1, p95LatencyMs: 42 }],
  topModelCosts: [{ modelId: 'gpt-4.1', estimatedCostNanoUsd: '4' }],
} as const;

const activityInput = {
  from: '2026-01-01',
  to: '2026-01-31',
  items: [
    {
      date: '2026-01-01',
      totalTokens: '100',
      models: [{ modelId: 'gpt-4.1', totalTokens: '60' }],
    },
  ],
} as const;

const legacyActivityInput = { year: 2026, days: [{ date: '2026-01-01', requestCount: '1' }] } as const;

test('preserves configured API and AI SDK display fields in dashboard summaries', () => {
  const base = {
    enabled: true,
    passthrough: false,
    last_status: 'unknown',
    last_latency: null,
    clientModels: [],
    state: { status: 'ready' },
  } as const;
  const api = {
    ...base,
    id: 'anthropic-api',
    kind: ProviderKind.Api,
    weight: 9,
    protocol: ProviderProtocol.Anthropic,
  } as const;
  const aiSdk = {
    ...base,
    id: 'anthropic-sdk',
    kind: ProviderKind.AiSdk,
    packageName: '@ai-sdk/anthropic',
  } as const;

  expect(DashboardProviderSummarySchema.parse(api)).toEqual(api);
  expect(DashboardProviderSummarySchema.parse(aiSdk)).toEqual(aiSdk);
  expect(DashboardProviderSummarySchema.parse(aiSdk)).not.toHaveProperty('protocol');
});

test('accepts independent range, diagnostics, and activity overview contracts', () => {
  const value = DashboardOverviewResponseSchema.parse(overviewInput);

  expect(value.range).toBe('90d');
  expect(DashboardOverviewDiagnosticsResponseSchema.parse(diagnosticsInput)).toEqual(diagnosticsInput);
  expect(DashboardOverviewActivityResponseSchema.parse(activityInput)).toEqual(activityInput);
  expect(DashboardOverviewActivityResponseSchema.safeParse(legacyActivityInput).success).toBe(false);
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

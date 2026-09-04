import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '../provider';
import { DashboardOverviewRangeSchema, UsageOverviewRangeSchema } from '../usage';
import {
  DashboardOverviewActivityResponseSchema,
  DashboardOverviewDiagnosticsResponseSchema,
  DashboardOverviewResponseSchema,
  DashboardProviderRoutingMutationSchema,
  DashboardProvidersResponseSchema,
  DashboardProviderSummarySchema,
} from './dashboard';

const currentTotals = {
  requestCount: '1',
  totalTokens: '2',
  inputTokens: '2',
  outputTokens: '0',
  cacheReadTokens: '1',
  cacheWriteTokens: '0',
  cacheHitRate: 0.5,
  estimatedCostNanoUsd: '0',
  averageRpm: 1,
  averageTpm: 2,
} as const;

// An empty comparison window must still parse: cacheHitRate is null without prompt traffic.
const previousTotals = {
  requestCount: '0',
  totalTokens: '0',
  inputTokens: '0',
  outputTokens: '0',
  cacheReadTokens: '0',
  cacheWriteTokens: '0',
  cacheHitRate: null,
  estimatedCostNanoUsd: '0',
  averageRpm: 0,
  averageTpm: 0,
} as const;

const overviewInput = {
  range: '90d',
  summary: {
    current: currentTotals,
    previous: previousTotals,
    peakRpm: 2,
    peakTpm: 4,
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
    protocols: [],
    hasQuota: false,
    canRefreshCredential: false,
    state: { status: 'ready' },
  } as const;
  const api = {
    ...base,
    id: 'anthropic-api',
    kind: ProviderKind.Api,
    weight: 9,
    protocols: [ProviderProtocol.Anthropic, ProviderProtocol.OpenAICompatible],
  } as const;
  const aiSdk = {
    ...base,
    id: 'anthropic-sdk',
    kind: ProviderKind.AiSdk,
    packageName: '@ai-sdk/anthropic',
  } as const;

  expect(DashboardProviderSummarySchema.parse(api)).toEqual(api);
  expect(DashboardProviderSummarySchema.parse(aiSdk)).toEqual(aiSdk);
  expect(DashboardProviderSummarySchema.parse(aiSdk).protocols).toEqual([]);
});

test('requires protocols and hasQuota on every summary', () => {
  const missing = {
    id: 'anthropic-api',
    kind: ProviderKind.Api,
    enabled: true,
    passthrough: false,
    last_status: 'unknown',
    last_latency: null,
    clientModels: [],
    state: { status: 'ready' },
  };

  expect(DashboardProviderSummarySchema.safeParse(missing).success).toBe(false);
});

test('parses the Provider routing snapshot and bounded routing mutation contract', () => {
  const provider = {
    id: 'alpha',
    kind: ProviderKind.Api,
    enabled: true,
    passthrough: false,
    last_status: 'unknown',
    last_latency: null,
    clientModels: [],
    protocols: [ProviderProtocol.OpenAICompatible],
    hasQuota: false,
    canRefreshCredential: false,
    state: { status: 'ready' },
  } as const;

  expect(DashboardProvidersResponseSchema.parse({ providers: [provider], routingRevision: 'revision' })).toEqual({
    providers: [provider],
    routingRevision: 'revision',
  });
  expect(
    DashboardProviderRoutingMutationSchema.parse({
      revision: 'revision',
      providers: { alpha: { priority: 20, weight: 10000 } },
    }),
  ).toEqual({ revision: 'revision', providers: { alpha: { priority: 20, weight: 10000 } } });
  expect(
    DashboardProviderRoutingMutationSchema.parse({
      revision: 'revision',
      providers: { alpha: { priority: 20, weight: 10001.4 } },
    }),
  ).toEqual({ revision: 'revision', providers: { alpha: { priority: 20, weight: 10000 } } });
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

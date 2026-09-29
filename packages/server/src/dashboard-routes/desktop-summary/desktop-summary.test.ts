import { expect, test } from 'bun:test';

import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import {
  DesktopSummaryV1Schema,
  type DashboardOverviewActivityResponse,
  type DashboardOverviewResponse,
  type DashboardProviderSummary,
  type DashboardUsageOverviewResponse,
} from '@aio-proxy/types';

import { createOAuthQuotaCache } from '../../plugin-quota';
import { OAuthQuotaCapabilityUnavailableError } from '../../plugin-quota/errors';
import { buildDesktopSummary, type DesktopSummarySource } from './desktop-summary';

const now = new Date('2026-09-29T08:00:00.000Z');
const totals = (requests: string) => ({
  requestCount: requests,
  totalTokens: '100',
  inputTokens: '60',
  outputTokens: '40',
  cacheReadTokens: '0',
  cacheWriteTokens: '0',
  cacheHitRate: null,
  estimatedCostNanoUsd: '5',
  averageRpm: 0,
  averageTpm: 0,
});
const trend = (values: Record<string, string>) => ({
  buckets: [{ key: '2026-09-28T16:00:00.000Z', values }],
  series: Object.keys(values).map((key) => ({ key, kind: 'dimension' as const })),
});

const traceStore: DesktopSummarySource['traceStore'] = {
  overview: () =>
    ({
      range: '24h',
      metric: 'requests',
      groupBy: 'provider',
      rangeStart: '2026-09-28T08:00:00.000Z',
      rangeEnd: now.toISOString(),
      bucketUnit: 'hour',
      summary: {
        estimatedCostNanoUsd: '20',
        pricingCoverage: 0.5,
        pricedRequestCount: '5',
        usageRequestCount: '9',
        requestCount: '10',
        successCount: '7',
        failureCount: '3',
        cancelledCount: '0',
        successRate: 0.7,
        inputTokens: '600',
        outputTokens: '400',
        totalTokens: '1000',
        averageRpm: 0,
        averageTpm: 0,
      },
      series: [],
      buckets: [],
    }) satisfies DashboardUsageOverviewResponse,
  overviewDashboard: () =>
    ({
      range: '7d',
      summary: { current: totals('10'), previous: totals('0'), peakRpm: 0, peakTpm: 0, providerCount: 2 },
      modelTrendByMetric: {
        requests: trend({ a: '4', b: '6' }),
        tokens: trend({ a: '40', b: '60' }),
        cost: trend({ a: '1', b: '2' }),
      },
    }) satisfies DashboardOverviewResponse,
  overviewDashboardActivity: () =>
    ({
      from: '2026-09-29',
      to: '2026-09-29',
      items: [{ date: '2026-09-29', totalTokens: '1000', models: [{ modelId: 'gpt', totalTokens: '1000' }] }],
    }) satisfies DashboardOverviewActivityResponse,
};

const provider = (overrides: Partial<DashboardProviderSummary>): DashboardProviderSummary => ({
  id: 'p',
  kind: 'oauth',
  enabled: true,
  passthrough: false,
  last_status: 'unknown',
  last_latency: null,
  protocols: [],
  hasQuota: false,
  canRefreshCredential: false,
  clientModels: [],
  state: { status: 'ready' },
  ...overrides,
});

const source = (
  providers: readonly DashboardProviderSummary[],
  read: (providerId: string) => Promise<OAuthQuotaSnapshot>,
): DesktopSummarySource => ({
  traceStore,
  providerSummaries: async () => providers,
  quotaCache: createOAuthQuotaCache({ read }),
});

const input = { version: '0.36.0', pid: 4312, ppid: 4310, now, refresh: false };

test('maps usage, the 7-day trend, activity, and providers into the strict v1 shape', async () => {
  const diagnostic = {
    code: 'CREDENTIAL_REFRESH_FAILED' as const,
    summary: 'Refresh token expired',
    retryable: true,
    occurredAt: now.toISOString(),
  };
  const cache = createOAuthQuotaCache({
    read: async () => ({
      items: [
        {
          id: 'primary',
          displayName: { default: '5 hours', 'zh-Hans': '5 小时' },
          remainingRatio: 0.4,
          resetsAt: Date.parse('2026-09-29T10:00:00.000Z'),
          windowMinutes: 300,
        },
      ],
    }),
  });
  await cache.read('codex');
  // The input carries every internal summary field (kind, protocols, last_status, clientModels, …);
  // the strict schema throws if any of them leaks into the DTO.
  const summary = await buildDesktopSummary(
    {
      traceStore,
      providerSummaries: async () => [
        provider({ id: 'codex', name: 'Codex', hasQuota: true, state: { status: 'ready', diagnostic } }),
      ],
      quotaCache: cache,
    },
    input,
  );
  expect(DesktopSummaryV1Schema.parse(summary)).toEqual(summary);
  expect(summary.providers).toEqual([
    {
      id: 'codex',
      name: 'Codex',
      enabled: true,
      state: 'degraded',
      diagnostic: { code: 'CREDENTIAL_REFRESH_FAILED', summary: 'Refresh token expired' },
      quota: {
        status: 'ready',
        sampledAt: expect.any(String),
        refreshFailed: false,
        windows: [
          {
            id: 'primary',
            label: { default: '5 hours', 'zh-Hans': '5 小时' },
            remainingRatio: 0.4,
            resetsAt: '2026-09-29T10:00:00.000Z',
            windowMinutes: 300,
          },
        ],
      },
    },
  ]);
  expect(summary.usage24h).toEqual({
    requests: '10',
    failedRequests: '3',
    inputTokens: '600',
    outputTokens: '400',
    estimatedCostNanoUsd: '20',
    pricingCoverage: 0.5,
  });
  expect(summary.trend7d).toEqual([
    { start: '2026-09-28T16:00:00.000Z', requests: '10', totalTokens: '100', estimatedCostNanoUsd: '3' },
  ]);
  expect(summary.activity).toEqual([{ date: '2026-09-29', totalTokens: '1000' }]);
  expect(summary.server).toEqual({ version: '0.36.0', pid: 4312, ppid: 4310 });
});

test('returns at once with quota loading while upstream never answers', async () => {
  const started = performance.now();
  const summary = await buildDesktopSummary(
    source([provider({ id: 'slow', hasQuota: true })], () => new Promise(() => {})),
    input,
  );
  expect(performance.now() - started).toBeLessThan(100);
  expect(summary.providers[0]?.quota).toEqual({ status: 'loading' });
});

test('one provider failing its quota read does not fail the summary', async () => {
  const cache = createOAuthQuotaCache({
    read: async (id) => {
      if (id === 'bad') throw new Error('boom');
      return {
        items: [
          {
            id: 'primary',
            displayName: 'Primary',
            remainingRatio: 0,
            resetsAt: Date.parse('2026-09-29T10:00:00.000Z'),
            windowMinutes: 300,
          },
        ],
      };
    },
  });
  await cache.read('bad').catch(() => {});
  await cache.read('good');
  const summary = await buildDesktopSummary(
    {
      traceStore,
      providerSummaries: async () => [
        provider({ id: 'bad', hasQuota: true }),
        provider({ id: 'good', hasQuota: true }),
      ],
      quotaCache: cache,
    },
    input,
  );
  expect(summary.providers.map((entry) => entry.quota.status)).toEqual(['failed', 'ready']);
  expect(summary.providers[1]?.quota).toEqual({
    status: 'ready',
    sampledAt: expect.any(String),
    refreshFailed: false,
    windows: [
      { id: 'primary', label: 'Primary', remainingRatio: 0, resetsAt: '2026-09-29T10:00:00.000Z', windowMinutes: 300 },
    ],
  });
  expect(summary.alerts).toContainEqual({ providerId: 'good', kind: 'quota_exhausted', message: 'Primary' });
});

test('an exhausted window with a localized label alerts with its default text', async () => {
  const cache = createOAuthQuotaCache({
    read: async () => ({
      items: [{ id: 'weekly', displayName: { 'zh-Hans': '每周', default: 'Weekly' }, remainingRatio: 0 }],
    }),
  });
  await cache.read('p');
  const summary = await buildDesktopSummary(
    { traceStore, providerSummaries: async () => [provider({ hasQuota: true })], quotaCache: cache },
    input,
  );
  expect(summary.alerts).toEqual([{ providerId: 'p', kind: 'quota_exhausted', message: 'Weekly' }]);
});

// Plugin quota values are not validated at runtime. A NaN resetsAt makes toISOString throw, and a
// ratio above 1 would break the contract; either must fail only its own Provider.
test('a plugin returning an invalid quota window fails only that provider', async () => {
  const items = {
    nan: [{ id: 'w', displayName: 'W', resetsAt: Number.NaN }],
    ratio: [{ id: 'w', displayName: 'W', remainingRatio: 1.5 }],
    fine: [{ id: 'w', displayName: 'W', remainingRatio: 0.5 }],
  } as const;
  const cache = createOAuthQuotaCache({ read: async (id) => ({ items: items[id as keyof typeof items] }) });
  for (const id of Object.keys(items)) await cache.read(id);
  const summary = await buildDesktopSummary(
    {
      traceStore,
      providerSummaries: async () => Object.keys(items).map((id) => provider({ id, hasQuota: true })),
      quotaCache: cache,
    },
    input,
  );
  expect(summary.providers.map((entry) => entry.quota.status)).toEqual(['failed', 'failed', 'ready']);
  expect(DesktopSummaryV1Schema.safeParse(summary).success).toBe(true);
});

test('a permanently unsupported quota capability reports unsupported, not loading forever', async () => {
  const cache = createOAuthQuotaCache({
    read: async () => {
      throw new OAuthQuotaCapabilityUnavailableError(true);
    },
  });
  await cache.read('p').catch(() => {});
  const summary = await buildDesktopSummary(
    { traceStore, providerSummaries: async () => [provider({ hasQuota: true })], quotaCache: cache },
    input,
  );
  expect(summary.providers[0]?.quota).toEqual({ status: 'unsupported' });
});

test('maps provider state and turns diagnostics into alerts', async () => {
  const diagnostic = {
    code: 'CREDENTIAL_REFRESH_FAILED' as const,
    summary: 'Refresh token expired',
    retryable: true,
    occurredAt: now.toISOString(),
  };
  const summary = await buildDesktopSummary(
    source(
      [
        provider({ id: 'off', enabled: false }),
        provider({ id: 'down', state: { status: 'unavailable', diagnostic } }),
        provider({ id: 'warn', name: 'Warn', state: { status: 'ready', diagnostic } }),
        provider({ id: 'fine' }),
      ],
      async () => ({ items: [] }),
    ),
    input,
  );
  expect(summary.providers.map(({ id, name, state }) => ({ id, name, state }))).toEqual([
    { id: 'off', name: 'off', state: 'disabled' },
    { id: 'down', name: 'down', state: 'unavailable' },
    { id: 'warn', name: 'Warn', state: 'degraded' },
    { id: 'fine', name: 'fine', state: 'ok' },
  ]);
  expect(summary.alerts.filter((alert) => alert.kind === 'diagnostic').map((alert) => alert.providerId)).toEqual([
    'down',
    'warn',
  ]);
});

test('refresh starts a background read even inside the cooldown and does not wait for it', async () => {
  let calls = 0;
  const cache = createOAuthQuotaCache({
    read: async () => {
      calls += 1;
      if (calls === 1) return { items: [] };
      return new Promise<OAuthQuotaSnapshot>(() => {});
    },
  });
  await cache.read('p');
  const summary = await buildDesktopSummary(
    { traceStore, providerSummaries: async () => [provider({ hasQuota: true })], quotaCache: cache },
    { ...input, refresh: true },
  );
  expect(calls).toBe(2);
  expect(summary.providers[0]?.quota.status).toBe('ready');
});

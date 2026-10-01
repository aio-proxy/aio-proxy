import { expect, test } from 'bun:test';

import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import {
  DesktopSummaryV1Schema,
  type DashboardOverviewActivityResponse,
  type DashboardProviderSummary,
} from '@aio-proxy/types';

import { createOAuthQuotaCache } from '../../plugin-quota';
import { OAuthQuotaCapabilityUnavailableError } from '../../plugin-quota/errors';
import { buildDesktopSummary, createUsageMemo, type DesktopSummarySource } from './desktop-summary';

const now = new Date('2026-09-29T08:00:00.000Z');
let usageCalls = 0;
const usage = (range: '24h' | '7d' | '30d') => ({
  range,
  bucketUnit: range === '24h' ? ('hour' as const) : ('day' as const),
  rangeStart: '2026-09-28T08:00:00.000Z',
  rangeEnd: now.toISOString(),
  current: {
    requests: '10',
    failedRequests: '3',
    inputTokens: '600',
    outputTokens: '400',
    estimatedCostNanoUsd: '20',
    pricingCoverage: 0.5,
  },
  previous: {
    requests: '8',
    failedRequests: '1',
    inputTokens: '500',
    outputTokens: '300',
    estimatedCostNanoUsd: '10',
    pricingCoverage: null,
  },
  buckets: [
    {
      start: '2026-09-28T08:00:00.000Z',
      requests: '10',
      failedRequests: '3',
      totalTokens: '1000',
      estimatedCostNanoUsd: '20',
    },
  ],
  byModel: [{ modelId: 'm', requests: '10', failedRequests: '3', totalTokens: '1000', estimatedCostNanoUsd: '20' }],
  byProvider: [
    { providerId: 'codex', requests: '9', failedRequests: '3', totalTokens: '900', estimatedCostNanoUsd: '20' },
    { providerId: 'gone', requests: '1', failedRequests: '0', totalTokens: '100', estimatedCostNanoUsd: '0' },
  ],
});

const traceStore: DesktopSummarySource['traceStore'] = {
  desktopUsage: ({ range }) => {
    usageCalls += 1;
    return usage(range);
  },
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

const input = { version: '0.36.0', pid: 4312, ppid: 4310, now, refresh: false, range: '24h' as const };

test('maps usage, activity, and providers into the strict v1 shape', async () => {
  const diagnostic = {
    code: 'CREDENTIAL_REFRESH_FAILED' as const,
    summary: 'Refresh token expired',
    retryable: true,
    occurredAt: now.toISOString(),
    suggestedCommand: 'aio-proxy provider login codex',
  };
  const cache = createOAuthQuotaCache({
    read: async () => ({
      plan: 'Pro',
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
        provider({
          id: 'codex',
          name: 'Codex',
          accountLabel: 'you@example.com',
          hasQuota: true,
          state: { status: 'ready', diagnostic },
        }),
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
      accountLabel: 'you@example.com',
      state: 'degraded',
      diagnostic: {
        code: 'CREDENTIAL_REFRESH_FAILED',
        summary: 'Refresh token expired',
        suggestedCommand: 'aio-proxy provider login --provider codex',
      },
      quota: {
        status: 'ready',
        sampledAt: expect.any(String),
        refreshFailed: false,
        plan: 'Pro',
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
  expect(summary.usage.current).toEqual({
    requests: '10',
    failedRequests: '3',
    inputTokens: '600',
    outputTokens: '400',
    estimatedCostNanoUsd: '20',
    pricingCoverage: 0.5,
  });
  expect(summary.usage.buckets).toEqual([
    {
      start: '2026-09-28T08:00:00.000Z',
      requests: '10',
      failedRequests: '3',
      totalTokens: '1000',
      estimatedCostNanoUsd: '20',
    },
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
    plan: null,
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
        provider({ id: 'blank', name: '' }),
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
    { id: 'blank', name: 'blank', state: 'ok' },
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

test('usage carries the requested range and names each Provider, falling back to its id', async () => {
  const summary = await buildDesktopSummary(
    source([provider({ id: 'codex', name: 'Codex' })], async () => ({ items: [] })),
    { ...input, range: '7d' },
  );
  expect(summary.usage.range).toBe('7d');
  expect(summary.usage.byProvider.map((entry) => entry.name)).toEqual(['Codex', 'gone']);
  expect(DesktopSummaryV1Schema.safeParse(summary).success).toBe(true);
});

const at = (ms: number) => new Date(now.getTime() + ms);
const memoSource = (): DesktopSummarySource => source([], async () => ({ items: [] }));

test('7d and 30d usage is memoized for 60 s per range and 24h always recomputes', async () => {
  let providers = [provider({ id: 'p', name: 'Before' })];
  const live: DesktopSummarySource = { ...memoSource(), providerSummaries: async () => providers };
  const memo = createUsageMemo();
  usageCalls = 0;
  await buildDesktopSummary(live, { ...input, range: '30d' }, memo);
  providers = [provider({ id: 'p', name: 'After' })];
  const hit = await buildDesktopSummary(live, { ...input, range: '30d', now: at(59_000) }, memo);
  expect(usageCalls).toBe(1);
  // Only usage is memoized: Provider state stays live on a memo hit.
  expect(hit.providers.map((entry) => entry.name)).toEqual(['After']);
  await buildDesktopSummary(live, { ...input, range: '30d', now: at(61_000) }, memo);
  expect(usageCalls).toBe(2);
  await buildDesktopSummary(live, { ...input, range: '7d' }, memo);
  expect(usageCalls).toBe(3);
  await buildDesktopSummary(live, { ...input, range: '24h' }, memo);
  await buildDesktopSummary(live, { ...input, range: '24h' }, memo);
  expect(usageCalls).toBe(5);
});

test('refresh=true bypasses the memo and replaces its entry', async () => {
  const memo = createUsageMemo();
  usageCalls = 0;
  await buildDesktopSummary(memoSource(), { ...input, range: '30d' }, memo);
  await buildDesktopSummary(memoSource(), { ...input, range: '30d', refresh: true, now: at(50_000) }, memo);
  expect(usageCalls).toBe(2);
  // 50 s after the refresh entry (a hit) but 100 s after the first one (a miss).
  await buildDesktopSummary(memoSource(), { ...input, range: '30d', now: at(100_000) }, memo);
  expect(usageCalls).toBe(2);
});

test('a clock stepping backwards recomputes instead of reusing the memo entry', async () => {
  const memo = createUsageMemo();
  usageCalls = 0;
  await buildDesktopSummary(memoSource(), { ...input, range: '30d', now: at(10_000) }, memo);
  await buildDesktopSummary(memoSource(), { ...input, range: '30d', now: at(9_000) }, memo);
  expect(usageCalls).toBe(2);
});

test('an invalid plan label loses only the plan, not the quota windows', async () => {
  const cache = createOAuthQuotaCache({
    read: async () => ({ plan: '  ', items: [{ id: 'w', displayName: 'W', remainingRatio: 0.5 }] }),
  });
  await cache.read('p');
  const summary = await buildDesktopSummary(
    { traceStore, providerSummaries: async () => [provider({ hasQuota: true })], quotaCache: cache },
    input,
  );
  expect(summary.providers[0]?.quota).toMatchObject({
    status: 'ready',
    plan: null,
    windows: [{ id: 'w', remainingRatio: 0.5 }],
  });
});

test('accountLabel, quota plan and the suggested command pass through as null when absent', async () => {
  const diagnostic = {
    code: 'CREDENTIAL_REFRESH_FAILED' as const,
    summary: 'Refresh token expired',
    retryable: true,
    occurredAt: now.toISOString(),
  };
  const cache = createOAuthQuotaCache({ read: async () => ({ items: [] }) });
  await cache.read('p');
  const summary = await buildDesktopSummary(
    {
      traceStore,
      providerSummaries: async () => [provider({ hasQuota: true, state: { status: 'ready', diagnostic } })],
      quotaCache: cache,
    },
    input,
  );
  expect(summary.providers[0]).toMatchObject({
    accountLabel: null,
    diagnostic: { suggestedCommand: null },
    quota: { status: 'ready', plan: null },
  });
});

import type { TraceStore } from '@aio-proxy/core/db';
import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import {
  DesktopQuotaSchema,
  type DashboardProviderSummary,
  type DesktopProvider,
  type DesktopQuota,
  type DesktopSummaryV1,
} from '@aio-proxy/types';

import type { OAuthQuotaCache, OAuthQuotaCacheEntry } from '../../plugin-quota';
import type { ServerState } from '../../server-state';

export type DesktopSummarySource = {
  readonly traceStore: Pick<TraceStore, 'overview' | 'overviewDashboard' | 'overviewDashboardActivity'>;
  readonly providerSummaries: ServerState['providerSummaries'];
  readonly quotaCache: Pick<OAuthQuotaCache, 'status' | 'warm' | 'refresh'>;
};

export type DesktopSummaryInput = {
  readonly version: string;
  readonly pid: number;
  readonly ppid: number;
  readonly now: Date;
  readonly refresh: boolean;
};

type Bucket = { readonly key: string; readonly values: Readonly<Record<string, string>> };

const sumValues = (values: Readonly<Record<string, string>>): string => {
  let total = 0n;
  for (const value of Object.values(values)) total += BigInt(value);
  return String(total);
};

const totalsByKey = (buckets: readonly Bucket[]): ReadonlyMap<string, string> =>
  new Map(buckets.map((bucket) => [bucket.key, sumValues(bucket.values)]));

function quotaWindows(snapshot: OAuthQuotaSnapshot) {
  return snapshot.items.map((item) => ({
    id: item.id,
    label: item.displayName,
    remainingRatio: item.remainingRatio ?? null,
    resetsAt: item.resetsAt === undefined ? null : new Date(item.resetsAt).toISOString(),
    windowMinutes: item.windowMinutes ?? null,
  }));
}

// Reads only what the cache already holds. `warm`/`refresh` start background reads whose results the
// next summary picks up; awaiting them is exactly the ~1.3s stall this endpoint exists to avoid.
function quotaFor(
  cache: DesktopSummarySource['quotaCache'],
  summary: DashboardProviderSummary,
  refresh: boolean,
): DesktopQuota {
  if (!summary.hasQuota) return { status: 'none' };
  if (refresh) cache.refresh(summary.id);
  else cache.warm(summary.id);
  const status = cache.status(summary.id);
  return status.kind === 'ready' ? readyQuota(status.entry) : { status: status.kind };
}

// Plugin quota values are typed but not validated at runtime: a NaN `resetsAt` throws in
// toISOString, and a ratio outside 0..1 or an empty label would break the contract. One bad plugin
// reports `failed` for its own Provider instead of failing the whole summary.
function readyQuota(entry: OAuthQuotaCacheEntry): DesktopQuota {
  try {
    const quota = DesktopQuotaSchema.safeParse({
      status: 'ready',
      sampledAt: new Date(entry.sampledAt).toISOString(),
      refreshFailed: entry.stale,
      windows: quotaWindows(entry.snapshot),
    });
    return quota.success ? quota.data : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

function providerState(summary: DashboardProviderSummary): DesktopProvider['state'] {
  if (!summary.enabled) return 'disabled';
  if (summary.state.status === 'unavailable') return 'unavailable';
  return summary.state.diagnostic === undefined ? 'ok' : 'degraded';
}

function toDesktopProvider(summary: DashboardProviderSummary, quota: DesktopQuota): DesktopProvider {
  const diagnostic = summary.state.diagnostic;
  return {
    id: summary.id,
    // `name: ""` is valid config but the DTO requires a non-empty name.
    name: summary.name === undefined || summary.name === '' ? summary.id : summary.name,
    enabled: summary.enabled,
    state: providerState(summary),
    diagnostic: diagnostic === undefined ? null : { code: diagnostic.code, summary: diagnostic.summary },
    quota,
  };
}

function alertsFor(providers: readonly DesktopProvider[]): DesktopSummaryV1['alerts'] {
  const alerts: DesktopSummaryV1['alerts'][number][] = [];
  for (const entry of providers) {
    if (entry.diagnostic !== null) {
      alerts.push({ providerId: entry.id, kind: 'diagnostic', message: entry.diagnostic.summary });
    }
    if (entry.quota.status !== 'ready') continue;
    for (const window of entry.quota.windows) {
      if (window.remainingRatio !== 0) continue;
      // The schema guarantees a map label has `default`; the id fallback only satisfies the index type.
      const message = typeof window.label === 'string' ? window.label : (window.label['default'] ?? window.id);
      alerts.push({ providerId: entry.id, kind: 'quota_exhausted', message });
    }
  }
  return alerts;
}

export async function buildDesktopSummary(
  source: DesktopSummarySource,
  input: DesktopSummaryInput,
): Promise<DesktopSummaryV1> {
  const usage = source.traceStore.overview({
    range: '24h',
    metric: 'requests',
    groupBy: 'provider',
    now: input.now,
  }).summary;
  const week = source.traceStore.overviewDashboard({ range: '7d', now: input.now }).modelTrendByMetric;
  const tokens = totalsByKey(week.tokens.buckets);
  const cost = totalsByKey(week.cost.buckets);
  const activity = source.traceStore.overviewDashboardActivity({ now: input.now });
  const summaries = await source.providerSummaries({ probe: false });
  const providers = summaries.map((summary) =>
    toDesktopProvider(summary, quotaFor(source.quotaCache, summary, input.refresh)),
  );
  return {
    protocolVersion: 1,
    generatedAt: input.now.toISOString(),
    server: { version: input.version, pid: input.pid, ppid: input.ppid },
    usage24h: {
      requests: usage.requestCount,
      failedRequests: usage.failureCount,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostNanoUsd: usage.estimatedCostNanoUsd,
      pricingCoverage: usage.pricingCoverage,
    },
    trend7d: week.requests.buckets.map((bucket) => ({
      start: bucket.key,
      requests: sumValues(bucket.values),
      totalTokens: tokens.get(bucket.key) ?? '0',
      estimatedCostNanoUsd: cost.get(bucket.key) ?? '0',
    })),
    activity: activity.items.map((item) => ({ date: item.date, totalTokens: item.totalTokens })),
    providers,
    alerts: alertsFor(providers),
  };
}

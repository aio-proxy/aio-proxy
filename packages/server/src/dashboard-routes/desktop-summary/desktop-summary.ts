import type { DesktopUsageResult, TraceStore } from '@aio-proxy/core/db';
import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import {
  DashboardLocalizedTextSchema,
  DesktopQuotaSchema,
  dashboardProviderSuggestedCommand,
  type DashboardProviderSummary,
  type DesktopProvider,
  type DesktopQuota,
  type DesktopSummaryV1,
  type DesktopUsageRange,
} from '@aio-proxy/types';

import type { OAuthQuotaCache, OAuthQuotaCacheEntry } from '../../plugin-quota';
import type { ServerState } from '../../server-state';

export type DesktopSummarySource = {
  readonly traceStore: Pick<TraceStore, 'desktopUsage' | 'overviewDashboardActivity'>;
  readonly providerSummaries: ServerState['providerSummaries'];
  readonly quotaCache: Pick<OAuthQuotaCache, 'status' | 'warm' | 'refresh'>;
};

export type DesktopSummaryInput = {
  readonly version: string;
  readonly pid: number;
  readonly ppid: number;
  readonly now: Date;
  readonly refresh: boolean;
  readonly range: DesktopUsageRange;
};

export const USAGE_MEMO_MS = 60_000;

export type UsageMemo = {
  readonly entries: Map<DesktopUsageRange, { readonly at: number; readonly usage: DesktopUsageResult }>;
};

export const createUsageMemo = (): UsageMemo => ({ entries: new Map() });

// 7d/30d split usage by Provider by scanning a month of root spans; once a minute is affordable,
// once per 15 s tick per open panel is not. 24h stays live: its query is measured at ≈46 ms for
// 36k requests/day; see docs/superpowers/specs/2026-10-01-desktop-panel-design.md, Cost and the
// usage memo.
function usageFor(
  source: DesktopSummarySource,
  input: DesktopSummaryInput,
  memo: UsageMemo | undefined,
): DesktopUsageResult {
  const compute = () => source.traceStore.desktopUsage({ range: input.range, now: input.now });
  if (input.range === '24h' || memo === undefined) return compute();
  const hit = memo.entries.get(input.range);
  // A clock that steps backwards (negative age) must not keep the entry alive.
  if (!input.refresh && hit !== undefined) {
    const age = input.now.getTime() - hit.at;
    if (age >= 0 && age < USAGE_MEMO_MS) return hit.usage;
  }
  const usage = compute();
  memo.entries.set(input.range, { at: input.now.getTime(), usage });
  return usage;
}

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
    // A malformed plan label only loses the plan, not the windows the user came for.
    const plan = DashboardLocalizedTextSchema.safeParse(entry.snapshot.plan);
    const quota = DesktopQuotaSchema.safeParse({
      status: 'ready',
      sampledAt: new Date(entry.sampledAt).toISOString(),
      refreshFailed: entry.stale,
      plan: plan.success ? plan.data : null,
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

// `name: ""` is valid config but the DTO requires a non-empty name.
const displayName = (summary: DashboardProviderSummary): string =>
  summary.name === undefined || summary.name === '' ? summary.id : summary.name;

function toDesktopProvider(summary: DashboardProviderSummary, quota: DesktopQuota): DesktopProvider {
  const diagnostic = summary.state.diagnostic;
  return {
    id: summary.id,
    name: displayName(summary),
    enabled: summary.enabled,
    accountLabel: summary.accountLabel === undefined || summary.accountLabel === '' ? null : summary.accountLabel,
    state: providerState(summary),
    diagnostic:
      diagnostic === undefined
        ? null
        : {
            code: diagnostic.code,
            summary: diagnostic.summary,
            suggestedCommand: dashboardProviderSuggestedCommand(summary) ?? null,
          },
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
  memo?: UsageMemo,
): Promise<DesktopSummaryV1> {
  const usage = usageFor(source, input, memo);
  const activity = source.traceStore.overviewDashboardActivity({ now: input.now });
  const summaries = await source.providerSummaries({ probe: false });
  const names = new Map(summaries.map((summary) => [summary.id, displayName(summary)]));
  const providers = summaries.map((summary) =>
    toDesktopProvider(summary, quotaFor(source.quotaCache, summary, input.refresh)),
  );
  return {
    protocolVersion: 1,
    generatedAt: input.now.toISOString(),
    server: { version: input.version, pid: input.pid, ppid: input.ppid },
    usage: {
      ...usage,
      // The query result is readonly; the DTO type is the mutable output of the schema.
      buckets: [...usage.buckets],
      byModel: [...usage.byModel],
      // A Provider removed from config still has history: it keeps its id as its name.
      byProvider: usage.byProvider.map((entry) => ({
        ...entry,
        name: names.get(entry.providerId) ?? entry.providerId,
      })),
    },
    activity: activity.items.map((item) => ({ date: item.date, totalTokens: item.totalTokens })),
    providers,
    alerts: alertsFor(providers),
  };
}

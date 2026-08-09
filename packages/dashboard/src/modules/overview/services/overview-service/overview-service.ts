import type { DashboardOverviewRange } from '@aio-proxy/types';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

type DashboardOverviewWireResponse = InferResponseType<typeof dashboardClient.dashboard.api.overview.$get, 200>;
type DashboardOverviewDiagnosticsWireResponse = InferResponseType<
  typeof dashboardClient.dashboard.api.overview.diagnostics.$get,
  200
>;
type DashboardOverviewActivityWireResponse = InferResponseType<
  typeof dashboardClient.dashboard.api.overview.activity.$get,
  200
>;
type DashboardOverviewWireTrend = DashboardOverviewWireResponse['modelTrendByMetric']['requests'];

const decodeTrend = (trend: DashboardOverviewWireTrend) => ({
  ...trend,
  buckets: trend.buckets.map((bucket) => ({
    ...bucket,
    values: Object.fromEntries(Object.entries(bucket.values).map(([key, value]) => [key, BigInt(value)])),
  })),
});

type DashboardOverviewWireTotals = DashboardOverviewWireResponse['summary']['current'];

const decodeSummaryTotals = (totals: DashboardOverviewWireTotals) => ({
  ...totals,
  requestCount: BigInt(totals.requestCount),
  totalTokens: BigInt(totals.totalTokens),
  inputTokens: BigInt(totals.inputTokens),
  outputTokens: BigInt(totals.outputTokens),
  cacheReadTokens: BigInt(totals.cacheReadTokens),
  cacheWriteTokens: BigInt(totals.cacheWriteTokens),
  estimatedCostNanoUsd: BigInt(totals.estimatedCostNanoUsd),
});

export const decodeOverview = (wire: DashboardOverviewWireResponse) => ({
  ...wire,
  summary: {
    ...wire.summary,
    current: decodeSummaryTotals(wire.summary.current),
    previous: decodeSummaryTotals(wire.summary.previous),
  },
  modelTrendByMetric: {
    requests: decodeTrend(wire.modelTrendByMetric.requests),
    tokens: decodeTrend(wire.modelTrendByMetric.tokens),
    cost: decodeTrend(wire.modelTrendByMetric.cost),
  },
});

export const decodeOverviewDiagnostics = (wire: DashboardOverviewDiagnosticsWireResponse) => ({
  ...wire,
  topModelCosts: wire.topModelCosts.map((model) => ({
    ...model,
    estimatedCostNanoUsd: BigInt(model.estimatedCostNanoUsd),
  })),
});

export const decodeOverviewActivity = (wire: DashboardOverviewActivityWireResponse) => ({
  ...wire,
  items: wire.items.map((item) => ({
    ...item,
    totalTokens: BigInt(item.totalTokens),
    models: item.models.map((model) => ({ ...model, totalTokens: BigInt(model.totalTokens) })),
  })),
});

export type OverviewData = ReturnType<typeof decodeOverview>;
export type OverviewDiagnosticsData = ReturnType<typeof decodeOverviewDiagnostics>;
export type OverviewActivityData = ReturnType<typeof decodeOverviewActivity>;

export class DashboardOverviewRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard overview request failed with status ${status}`);
    this.name = 'DashboardOverviewRequestError';
  }
}

export type OverviewQueryInput = {
  readonly range: DashboardOverviewRange;
};

export const overviewQueryOptions = (input: OverviewQueryInput) =>
  queryOptions({
    queryKey: queryKeys.overviewRange(input.range),
    queryFn: () => getOverview(input),
    placeholderData: keepPreviousData,
    refetchInterval: input.range === '24h' ? (query) => (query.state.status === 'error' ? false : 5_000) : false,
    refetchIntervalInBackground: false,
  });

export const overviewDiagnosticsQueryOptions = (input: OverviewQueryInput) =>
  queryOptions({
    queryKey: queryKeys.overviewDiagnostics(input.range),
    queryFn: () => getOverviewDiagnostics(input),
    placeholderData: keepPreviousData,
    refetchInterval: false,
    staleTime: 60_000,
  });

export const overviewActivityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.overviewActivity,
    queryFn: getOverviewActivity,
    placeholderData: keepPreviousData,
    refetchInterval: false,
    staleTime: 60_000,
  });

export const getOverview = async (input: OverviewQueryInput): Promise<OverviewData> => {
  const response = await dashboardClient.dashboard.api.overview.$get({
    query: { range: input.range },
  });
  if (!response.ok) throw new DashboardOverviewRequestError(response.status);
  return decodeOverview(await response.json());
};

export const getOverviewDiagnostics = async (input: OverviewQueryInput): Promise<OverviewDiagnosticsData> => {
  const response = await dashboardClient.dashboard.api.overview.diagnostics.$get({
    query: { range: input.range },
  });
  if (!response.ok) throw new DashboardOverviewRequestError(response.status);
  return decodeOverviewDiagnostics(await response.json());
};

export const getOverviewActivity = async (): Promise<OverviewActivityData> => {
  const response = await dashboardClient.dashboard.api.overview.activity.$get();
  if (!response.ok) throw new DashboardOverviewRequestError(response.status);
  return decodeOverviewActivity(await response.json());
};

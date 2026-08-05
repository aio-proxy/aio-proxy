import type { DashboardOverviewRange } from '@aio-proxy/types';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';

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

export const decodeOverview = (wire: DashboardOverviewWireResponse) => ({
  ...wire,
  summary: {
    ...wire.summary,
    requestCount: BigInt(wire.summary.requestCount),
    totalTokens: BigInt(wire.summary.totalTokens),
    cacheReadTokens: BigInt(wire.summary.cacheReadTokens),
    cacheWriteTokens: BigInt(wire.summary.cacheWriteTokens),
    estimatedCostNanoUsd: BigInt(wire.summary.estimatedCostNanoUsd),
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
    queryKey: ['dashboard', 'overview', 'range', input.range],
    queryFn: () => getOverview(input),
    placeholderData: keepPreviousData,
    refetchInterval: input.range === '24h' ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

export const overviewDiagnosticsQueryOptions = () =>
  queryOptions({
    queryKey: ['dashboard', 'overview', 'diagnostics'],
    queryFn: getOverviewDiagnostics,
    refetchInterval: false,
    staleTime: 60_000,
  });

export const overviewActivityQueryOptions = () =>
  queryOptions({
    queryKey: ['dashboard', 'overview', 'activity'],
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

export const getOverviewDiagnostics = async (): Promise<OverviewDiagnosticsData> => {
  const response = await dashboardClient.dashboard.api.overview.diagnostics.$get();
  if (!response.ok) throw new DashboardOverviewRequestError(response.status);
  return decodeOverviewDiagnostics(await response.json());
};

export const getOverviewActivity = async (): Promise<OverviewActivityData> => {
  const response = await dashboardClient.dashboard.api.overview.activity.$get();
  if (!response.ok) throw new DashboardOverviewRequestError(response.status);
  return decodeOverviewActivity(await response.json());
};

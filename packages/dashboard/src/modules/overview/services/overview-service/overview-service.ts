import type { DashboardOverviewRange } from '@aio-proxy/types';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';

type DashboardOverviewWireResponse = InferResponseType<typeof dashboardClient.dashboard.api.overview.$get, 200>;
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
  topModelCosts: wire.topModelCosts.map((model) => ({
    ...model,
    estimatedCostNanoUsd: BigInt(model.estimatedCostNanoUsd),
  })),
  activity: {
    ...wire.activity,
    days: wire.activity.days.map((day) => ({ ...day, requestCount: BigInt(day.requestCount) })),
  },
});

export type OverviewData = ReturnType<typeof decodeOverview>;

export class DashboardOverviewRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard overview request failed with status ${status}`);
    this.name = 'DashboardOverviewRequestError';
  }
}

export type OverviewQueryInput = {
  readonly range: DashboardOverviewRange;
  readonly year: number;
};

export const overviewQueryOptions = (input: OverviewQueryInput) =>
  queryOptions({
    queryKey: ['dashboard', 'overview', input.range, input.year],
    queryFn: () => getOverview(input),
    placeholderData: keepPreviousData,
    refetchInterval: input.range === '24h' ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

export const getOverview = async (input: OverviewQueryInput): Promise<OverviewData> => {
  const response = await dashboardClient.dashboard.api.overview.$get({
    query: { range: input.range, year: String(input.year) },
  });
  if (!response.ok) throw new DashboardOverviewRequestError(response.status);
  return decodeOverview(await response.json());
};

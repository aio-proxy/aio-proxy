import type { UsageOverviewGroupBy, UsageOverviewMetric, UsageOverviewRange } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

type DashboardUsageWireResponse = InferResponseType<typeof dashboardClient.dashboard.api.usage.$get, 200>;

export const decodeUsageOverview = (wire: DashboardUsageWireResponse) => ({
  ...wire,
  summary: {
    ...wire.summary,
    estimatedCostNanoUsd: BigInt(wire.summary.estimatedCostNanoUsd),
    pricedRequestCount: BigInt(wire.summary.pricedRequestCount),
    usageRequestCount: BigInt(wire.summary.usageRequestCount),
    requestCount: BigInt(wire.summary.requestCount),
    successCount: BigInt(wire.summary.successCount),
    failureCount: BigInt(wire.summary.failureCount),
    cancelledCount: BigInt(wire.summary.cancelledCount),
    inputTokens: BigInt(wire.summary.inputTokens),
    outputTokens: BigInt(wire.summary.outputTokens),
    totalTokens: BigInt(wire.summary.totalTokens),
  },
  buckets: wire.buckets.map((bucket) => ({
    ...bucket,
    values: Object.fromEntries(Object.entries(bucket.values).map(([key, value]) => [key, BigInt(value)])),
  })),
});

export type UsageOverviewData = ReturnType<typeof decodeUsageOverview>;

export class DashboardUsageRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Dashboard usage request failed with status ${status}`);
    this.name = 'DashboardUsageRequestError';
    this.status = status;
  }
}

export type UsageQueryInput = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
};

export const usageQueryOptions = (input: UsageQueryInput) =>
  queryOptions({
    queryKey: queryKeys.usage(input.range, input.metric, input.groupBy),
    queryFn: () => getUsage(input),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

export const getUsage = async (input: UsageQueryInput): Promise<UsageOverviewData> => {
  const response = await dashboardClient.dashboard.api.usage.$get({
    query: { range: input.range, metric: input.metric, groupBy: input.groupBy },
  });
  if (!response.ok) {
    throw new DashboardUsageRequestError(response.status);
  }
  return decodeUsageOverview(await response.json());
};

export type UsageOverviewSeries = UsageOverviewData['series'][number];
export type UsageOverviewSummary = UsageOverviewData['summary'];

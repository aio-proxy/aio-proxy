import type { UsageOverviewMetric } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

type DashboardUsageWireResponse = InferResponseType<typeof dashboardClient.dashboard.api.usage.$get, 200>;

export type ProviderUsage = {
  readonly requestCount: bigint;
  readonly totalTokens: bigint;
  readonly estimatedCostNanoUsd: bigint;
};

class DashboardUsageRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard usage request failed with status ${status}`);
    this.name = 'DashboardUsageRequestError';
  }
}

const metrics = ['requests', 'tokens', 'cost'] as const;
const dimensionPrefix = 'dimension:';

const emptyProviderUsage = (): ProviderUsage => ({ requestCount: 0n, totalTokens: 0n, estimatedCostNanoUsd: 0n });

const addMetric = (usage: ProviderUsage, metric: UsageOverviewMetric, value: bigint): ProviderUsage => {
  if (metric === 'requests') return { ...usage, requestCount: usage.requestCount + value };
  if (metric === 'tokens') return { ...usage, totalTokens: usage.totalTokens + value };
  return { ...usage, estimatedCostNanoUsd: usage.estimatedCostNanoUsd + value };
};

const addUsageResponse = (
  totals: Map<string, ProviderUsage>,
  metric: UsageOverviewMetric,
  response: DashboardUsageWireResponse,
) => {
  for (const bucket of response.buckets) {
    for (const [key, value] of Object.entries(bucket.values)) {
      if (!key.startsWith(dimensionPrefix)) continue;
      const providerId = decodeURIComponent(key.slice(dimensionPrefix.length));
      totals.set(providerId, addMetric(totals.get(providerId) ?? emptyProviderUsage(), metric, BigInt(value)));
    }
  }
};

export const getProviderUsage = async (): Promise<ReadonlyMap<string, ProviderUsage>> => {
  const responses = await Promise.all(
    metrics.map((metric) =>
      dashboardClient.dashboard.api.usage.$get({ query: { range: '24h', metric, groupBy: 'provider' } }),
    ),
  );
  const totals = new Map<string, ProviderUsage>();

  for (const [index, response] of responses.entries()) {
    if (!response.ok) throw new DashboardUsageRequestError(response.status);
    addUsageResponse(totals, metrics[index]!, await response.json());
  }

  return totals;
};

export const providerUsageQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.usage('24h', 'requests', 'provider'),
    queryFn: getProviderUsage,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

import { queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

type DashboardUsageWireResponse = InferResponseType<typeof dashboardClient.dashboard.api.usage.$get, 200>;

export type ProviderUsage = {
  readonly requestCount: bigint;
};

class DashboardUsageRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard usage request failed with status ${status}`);
    this.name = 'DashboardUsageRequestError';
  }
}

const dimensionPrefix = 'dimension:';

const emptyProviderUsage = (): ProviderUsage => ({ requestCount: 0n });

const addUsageResponse = (totals: Map<string, ProviderUsage>, response: DashboardUsageWireResponse) => {
  for (const bucket of response.buckets) {
    for (const [key, value] of Object.entries(bucket.values)) {
      if (!key.startsWith(dimensionPrefix)) continue;
      const providerId = decodeURIComponent(key.slice(dimensionPrefix.length));
      const usage = totals.get(providerId) ?? emptyProviderUsage();
      totals.set(providerId, { requestCount: usage.requestCount + BigInt(value) });
    }
  }
};

export const getProviderUsage = async (): Promise<ReadonlyMap<string, ProviderUsage>> => {
  const response = await dashboardClient.dashboard.api.usage.$get({
    query: { range: '24h', metric: 'requests', groupBy: 'provider' },
  });
  if (!response.ok) throw new DashboardUsageRequestError(response.status);
  const totals = new Map<string, ProviderUsage>();
  addUsageResponse(totals, await response.json());

  return totals;
};

export const providerUsageQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.providerUsage,
    queryFn: getProviderUsage,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

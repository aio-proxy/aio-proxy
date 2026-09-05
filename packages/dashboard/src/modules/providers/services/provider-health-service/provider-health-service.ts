import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export type ProviderHealth = {
  readonly successRate: number;
  readonly p95LatencyMs: number;
  readonly totalTokens: bigint;
};

class DashboardProviderHealthRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider health request failed with status ${status}`);
    this.name = 'DashboardProviderHealthRequestError';
  }
}

export const getProviderHealth = async (): Promise<ReadonlyMap<string, ProviderHealth>> => {
  const response = await dashboardClient.dashboard.api.overview.diagnostics.$get({ query: { range: '24h' } });
  if (!response.ok) throw new DashboardProviderHealthRequestError(response.status);
  const { providerHealth } = await response.json();
  return new Map(
    (providerHealth ?? []).map((entry) => [
      entry.providerId,
      {
        successRate: entry.successRate,
        p95LatencyMs: entry.p95LatencyMs,
        totalTokens: BigInt(entry.totalTokens),
      },
    ]),
  );
};

export const providerHealthQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.providerHealth,
    queryFn: getProviderHealth,
    staleTime: 60_000,
    // Matches the sibling usage query so one card's success rate, p95, and request count all move on
    // the same tick. `staleTime` alone only marks the entry stale, and the client disables refetch on
    // focus, so a parked Providers page would otherwise show these two numbers at different ages.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

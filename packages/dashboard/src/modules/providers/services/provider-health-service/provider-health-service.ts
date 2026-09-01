import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export type ProviderHealth = {
  readonly successRate: number;
  readonly p95LatencyMs: number;
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
      { successRate: entry.successRate, p95LatencyMs: entry.p95LatencyMs },
    ]),
  );
};

export const providerHealthQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.providerHealth,
    queryFn: getProviderHealth,
    staleTime: 60_000,
  });

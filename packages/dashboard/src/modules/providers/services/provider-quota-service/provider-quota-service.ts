import { queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

const quotaEndpoint = dashboardClient.dashboard.api.providers[':id'].quota.$query;

export type ProviderQuotaResult = InferResponseType<typeof quotaEndpoint, 200>;

class DashboardProviderQuotaRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider quota request failed with status ${status}`);
    this.name = 'DashboardProviderQuotaRequestError';
  }
}

export const getProviderQuota = async (id: string, refresh: boolean): Promise<ProviderQuotaResult> => {
  const response = await quotaEndpoint({ param: { id }, json: { refresh } });
  if (!response.ok) throw new DashboardProviderQuotaRequestError(response.status);
  return await response.json();
};

/**
 * The passive read. `refresh` is deliberately absent from both the key and the function: the card and
 * the dialog share one cache entry, and a passive render must never bypass the server's cooldown.
 * Explicit refreshes go through `useProviderQuotaRefresh`.
 */
export const providerQuotaQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.providerQuota(id),
    queryFn: () => getProviderQuota(id, false),
    staleTime: 30_000,
    // Matches the sibling health query. `staleTime` alone only marks the entry stale and the client
    // disables refetch on focus, so a parked Providers page would keep showing the reading it loaded
    // with while the pipeline's warm updated only the server cache. Each poll is an in-memory cache
    // hit for the rest of the server's five-minute cooldown, not an upstream quota read.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

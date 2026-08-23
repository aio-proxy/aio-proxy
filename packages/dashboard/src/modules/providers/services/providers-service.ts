import type {
  DashboardProviderEnabledMutationBody,
  DashboardProviderSummary,
  DashboardRoutingNumber,
  ProviderMutationBody,
} from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { createDashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export type ProviderEditRouting = {
  readonly priority: DashboardRoutingNumber;
  readonly weight: DashboardRoutingNumber;
};

export const providerFormRoutingValues = (
  routing: ProviderEditRouting | undefined,
): { readonly priority?: number; readonly weight?: number } => ({
  ...(routing?.priority.authored === undefined ? {} : { priority: routing.priority.authored }),
  ...(routing?.weight.authored === undefined ? {} : { weight: routing.weight.authored }),
});

const dashboardClient = createDashboardClient();

export const providersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.providers,
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.providers.$get();
      return response.json();
    },
  });

export const fetchProviderEditView = async (id: string) => {
  const response = await dashboardClient.dashboard.api.providers[':id']['edit-view'].$get({
    param: { id },
  });
  return response.json();
};

export const providerEditViewQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.providerEditView(id),
    queryFn: () => fetchProviderEditView(id),
  });

export const createProviderMutationFn = async (
  body: ProviderMutationBody,
): Promise<{ provider: DashboardProviderSummary }> => {
  const response = await dashboardClient.dashboard.api.providers.$post({ json: body });
  if (!response.ok) {
    throw new Error(`create provider failed: ${response.status}`);
  }
  return response.json();
};

export const updateProviderMutationFn = async ({
  id,
  body,
}: {
  id: string;
  body: ProviderMutationBody;
}): Promise<{ provider: DashboardProviderSummary }> => {
  const response = await dashboardClient.dashboard.api.providers[':id'].$put({ param: { id }, json: body });
  if (!response.ok) {
    throw new Error(`update provider failed: ${response.status}`);
  }
  return response.json();
};

export const deleteProviderMutationFn = async (id: string): Promise<{ ok: true; id: string }> => {
  const response = await dashboardClient.dashboard.api.providers[':id'].$delete({ param: { id } });
  if (!response.ok) {
    throw new Error(`delete provider failed: ${response.status}`);
  }
  return response.json();
};

export const updateProviderEnabledMutationFn = async ({
  id,
  enabled,
}: DashboardProviderEnabledMutationBody & {
  readonly id: string;
}): Promise<{ provider: DashboardProviderSummary }> => {
  const response = await dashboardClient.dashboard.api.providers[':id'].enabled.$patch({
    param: { id },
    json: { enabled },
  });
  if (!response.ok) {
    throw new Error(`update provider enabled failed: ${response.status}`);
  }
  return response.json();
};

export const probeProviderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.providerProbe(id),
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.providers[':id'].$get({
        param: { id },
        query: { probe: 'true' },
      });
      return response.json();
    },
  });

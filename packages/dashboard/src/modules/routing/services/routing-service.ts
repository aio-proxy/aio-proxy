import type { DashboardRoutingModelMutation, DashboardRoutingModelsResponse } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { createDashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

const dashboardClient = createDashboardClient();

export const routingModelsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.routingModels,
    queryFn: async (): Promise<DashboardRoutingModelsResponse> => {
      const response = await dashboardClient.dashboard.api.routing.models.$get();
      if (!response.ok) throw new Error(`routing models failed: ${response.status}`);
      return response.json();
    },
  });

export async function updateRoutingModelMutationFn(body: DashboardRoutingModelMutation) {
  const response = await dashboardClient.dashboard.api.routing.models.$put({ json: body });
  if (response.status === 409) {
    const error = new Error('stale routing model');
    Object.assign(error, { code: (await response.json()).error });
    throw error;
  }
  if (!response.ok) throw new Error(`update routing model failed: ${response.status}`);
  return response.json();
}

export const isStaleRoutingError = (error: unknown): error is Error & { readonly code: 'stale_revision' } =>
  error instanceof Error && 'code' in error && error.code === 'stale_revision';

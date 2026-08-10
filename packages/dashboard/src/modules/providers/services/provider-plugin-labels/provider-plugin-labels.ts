import type { DashboardPluginSummary } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

const getProviderPlugins = async (): Promise<{ plugins: readonly DashboardPluginSummary[] }> => {
  const response = await dashboardClient.dashboard.api.plugins.$get();
  if (!response.ok) throw new Error(`Dashboard plugin request failed with status ${response.status}`);
  return response.json();
};

export const providerPluginPresentationsQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.plugins, queryFn: getProviderPlugins });

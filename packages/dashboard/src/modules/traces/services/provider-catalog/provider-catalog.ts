import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export const providerCatalogQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.providers,
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.providers.$get();
      if (!response.ok) throw new Error(`Dashboard provider request failed with status ${response.status}`);
      return response.json();
    },
  });

export const providerCatalogPluginsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.plugins,
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.plugins.$get();
      if (!response.ok) throw new Error(`Dashboard plugin request failed with status ${response.status}`);
      return response.json();
    },
  });

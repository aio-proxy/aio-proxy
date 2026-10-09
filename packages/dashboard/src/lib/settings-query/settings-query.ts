import type { DashboardSettingsView } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings,
    queryFn: async (): Promise<DashboardSettingsView> => {
      const response = await dashboardClient.dashboard.api.settings.$get();
      if (!response.ok) throw new Error(`load settings failed: ${response.status}`);
      return response.json();
    },
  });

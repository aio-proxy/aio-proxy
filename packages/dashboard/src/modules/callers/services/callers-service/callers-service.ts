import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';

export const callersQueryOptions = () =>
  queryOptions({
    queryKey: ['overview', 'callers'],
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.overview.callers.$get();
      if (!response.ok) throw new Error(`Usage callers request failed: ${response.status}`);
      return response.json();
    },
  });

import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

// The providers page and ProviderIdLabel both read this list. It lives outside the providers
// module so the shared label does not depend on that module.
export const providersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.providers,
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.providers.$get();
      return response.json();
    },
  });

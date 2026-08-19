import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export const modelsDevSlugsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.modelsDevSlugs,
    queryFn: async () => (await dashboardClient.dashboard.api['models-dev'].slugs.$get()).json(),
  });

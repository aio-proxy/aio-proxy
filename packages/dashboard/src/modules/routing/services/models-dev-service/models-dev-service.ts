import { queryOptions } from '@tanstack/react-query';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

export const fetchModelsDevSlugs = async () => {
  const response = await dashboardClient.dashboard.api['models-dev'].slugs.$get();
  // Hono's client does not throw on 4xx/5xx; `.json()` still succeeds when the body is JSON, so
  // `slugs.isError` would stay false and the picker would report an empty catalog.
  if (!response.ok) throw new Error('models.dev slugs request failed');
  return response.json();
};

export const modelsDevSlugsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.modelsDevSlugs,
    queryFn: fetchModelsDevSlugs,
  });

export const fetchModelsDevLookup = async (id: string) => {
  const response = await dashboardClient.dashboard.api['models-dev'].lookup.$get({ query: { id } });
  if (!response.ok) throw new Error('models.dev lookup request failed');
  return response.json();
};

export const modelsDevLookupQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.modelsDevLookup(id),
    queryFn: () => fetchModelsDevLookup(id),
    enabled: id.trim() !== '',
  });

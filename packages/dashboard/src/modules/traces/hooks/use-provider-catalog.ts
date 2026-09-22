import { useQuery } from '@tanstack/react-query';

import { providerCatalogPluginsQueryOptions, providerCatalogQueryOptions } from '../services/provider-catalog';

// Traces owns this read. The cache keys match the providers page, so a loaded catalog is reused.
// A failed refresh keeps the previous payload on the query; only a successful query is shown,
// so a deleted or renamed Provider falls back to its ID.
export const useProviderCatalog = () => {
  const providers = useQuery(providerCatalogQueryOptions());
  const plugins = useQuery(providerCatalogPluginsQueryOptions());
  return {
    providers: providers.isSuccess ? providers.data?.providers : undefined,
    plugins: plugins.isSuccess ? plugins.data?.plugins : undefined,
  };
};

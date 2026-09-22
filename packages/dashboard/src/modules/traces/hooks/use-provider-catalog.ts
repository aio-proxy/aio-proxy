import { useQuery } from '@tanstack/react-query';

import { providerCatalogPluginsQueryOptions, providerCatalogQueryOptions } from '../services/provider-catalog';

// Traces owns this read. The cache keys match the providers page, so a loaded catalog is reused.
export const useProviderCatalog = () => {
  const providers = useQuery(providerCatalogQueryOptions());
  const plugins = useQuery(providerCatalogPluginsQueryOptions());
  return { providers: providers.data?.providers, plugins: plugins.data?.plugins };
};

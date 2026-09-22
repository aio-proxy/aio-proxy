import { useQuery } from '@tanstack/react-query';

import { providerPluginPresentationsQueryOptions } from '@/modules/providers/services/provider-plugin-labels';
import { providersQueryOptions } from '@/modules/providers/services/providers-query';

// The shared label is presentation-only. Traces is the module that reads the catalog.
export const useProviderCatalog = () => {
  const providers = useQuery(providersQueryOptions());
  const plugins = useQuery(providerPluginPresentationsQueryOptions());
  return { providers: providers.data?.providers, plugins: plugins.data?.plugins };
};

import type { DashboardPluginSummary, DashboardProviderSummary } from '@aio-proxy/types';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';
import type React from 'react';

import { providerCatalogPluginsQueryOptions, providerCatalogQueryOptions } from '@/services/provider-catalog';

export interface ProviderCatalogValue {
  readonly providers: readonly DashboardProviderSummary[] | undefined;
  readonly plugins: readonly DashboardPluginSummary[] | undefined;
  readonly status: 'loading' | 'ready' | 'error';
}

const ProviderCatalogContext = createContext<ProviderCatalogValue | undefined>(undefined);

interface ProviderCatalogProviderProps {
  readonly value: ProviderCatalogValue;
  readonly children: React.ReactNode;
}

export const ProviderCatalogProvider: React.FC<ProviderCatalogProviderProps> = ({ value, children }) => (
  <ProviderCatalogContext.Provider value={value}>{children}</ProviderCatalogContext.Provider>
);

export const useProviderCatalogContext = (): ProviderCatalogValue | undefined => useContext(ProviderCatalogContext);

/**
 * Provider catalog is a shared query. Pages load it once and expose the result through the context so
 * many ProviderLabel instances only subscribe to the same snapshot and never issue per-row requests.
 */
export const useProviderCatalog = (): ProviderCatalogValue => {
  const providersQuery = useQuery(providerCatalogQueryOptions());
  const pluginsQuery = useQuery(providerCatalogPluginsQueryOptions());
  const status = providersQuery.isPending ? 'loading' : providersQuery.isError ? 'error' : ('ready' as const);

  return useMemo(
    () => ({
      providers: providersQuery.isSuccess ? providersQuery.data.providers : undefined,
      plugins: pluginsQuery.isSuccess ? pluginsQuery.data.plugins : undefined,
      status,
    }),
    [pluginsQuery.data, pluginsQuery.isSuccess, providersQuery.data, providersQuery.isSuccess, status],
  );
};

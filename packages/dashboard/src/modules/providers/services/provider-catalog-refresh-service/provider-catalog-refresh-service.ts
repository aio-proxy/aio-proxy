import { dashboardClient } from '@/lib/dashboard-client';

const catalogRefreshEndpoint = dashboardClient.dashboard.api.providers[':id'].catalog.refresh.$post;

class DashboardProviderCatalogRefreshError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider catalog refresh failed with status ${status}`);
    this.name = 'DashboardProviderCatalogRefreshError';
  }
}

/**
 * The success body is a bare acknowledgement, so nothing is read from it: the server already awaited
 * the snapshot rebuild, so the caller reads the new model list through its own edit-view query.
 */
export const refreshProviderCatalog = async (id: string): Promise<void> => {
  const response = await catalogRefreshEndpoint({ param: { id } });
  if (!response.ok) throw new DashboardProviderCatalogRefreshError(response.status);
};

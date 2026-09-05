import { dashboardClient } from '@/lib/dashboard-client';

const catalogRefreshEndpoint = dashboardClient.dashboard.api.providers[':id'].catalog.refresh.$post;

class DashboardProviderCatalogRefreshError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider catalog refresh failed with status ${status}`);
    this.name = 'DashboardProviderCatalogRefreshError';
  }
}

/**
 * Rediscovers the Provider's catalog upstream and returns the model list the refresh committed. The
 * server awaits its own snapshot rebuild before answering, so this list is already routable and the
 * caller needs no follow-up read.
 */
export const refreshProviderCatalog = async (id: string): Promise<readonly string[]> => {
  const response = await catalogRefreshEndpoint({ param: { id } });
  if (!response.ok) throw new DashboardProviderCatalogRefreshError(response.status);
  const { models } = await response.json();
  return models;
};

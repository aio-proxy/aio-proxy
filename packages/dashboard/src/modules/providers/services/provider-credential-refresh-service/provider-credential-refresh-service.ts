import { dashboardClient } from '@/lib/dashboard-client';

const credentialRefreshEndpoint = dashboardClient.dashboard.api.providers[':id'].credential.refresh.$post;

class DashboardProviderCredentialRefreshError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider credential refresh failed with status ${status}`);
    this.name = 'DashboardProviderCredentialRefreshError';
  }
}

/**
 * The success body is a bare acknowledgement, so nothing is read from it: the server queues the
 * summary rebuild rather than awaiting it, and the failure body carries an error code the UI must
 * not show, so only the status reaches the caller.
 */
export const refreshProviderCredential = async (id: string): Promise<void> => {
  const response = await credentialRefreshEndpoint({ param: { id } });
  if (!response.ok) throw new DashboardProviderCredentialRefreshError(response.status);
};

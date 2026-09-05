import { dashboardClient } from '@/lib/dashboard-client';

const quotaResetEndpoint = dashboardClient.dashboard.api.providers[':id'].quota.reset.$post;

/** The status the dashboard distinguishes: the credit is gone, which is not an upstream failure. */
export const QUOTA_RESET_UNAVAILABLE_STATUS = 409;

export class DashboardProviderQuotaResetError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard provider quota reset failed with status ${status}`);
    this.name = 'DashboardProviderQuotaResetError';
  }
}

/**
 * The success body is a bare acknowledgement. Nothing is read from it: the server drops its cached
 * snapshot rather than returning the post-reset reading, so the caller refetches the quota query.
 */
export const resetProviderQuota = async (id: string): Promise<void> => {
  const response = await quotaResetEndpoint({ param: { id } });
  if (!response.ok) throw new DashboardProviderQuotaResetError(response.status);
};

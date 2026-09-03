import { createDashboardClient } from '@/lib/dashboard-client';

const dashboardClient = createDashboardClient();

export interface ReloadProviderDiff {
  readonly providerIds: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
}

export class ReloadFailedError extends Error {
  constructor(readonly stage: string) {
    super(`config reload failed at ${stage}`);
  }
}

export const reloadConfigMutationFn = async (): Promise<ReloadProviderDiff> => {
  const response = await dashboardClient.dashboard.api.reload.$post();
  const result = await response.json();
  if (!result.ok) throw new ReloadFailedError(result.stage);
  return result.diff;
};

import type { DashboardSettingsMutationInput, DashboardSettingsMutationResponse } from '@aio-proxy/types';

import { createDashboardClient } from '@/lib/dashboard-client';

export { settingsQueryOptions } from '@/lib/settings-query';

const dashboardClient = createDashboardClient();

export type DashboardSettingsMutationSuccess = Extract<DashboardSettingsMutationResponse, { readonly ok: true }>;

export const updateSettingsMutationFn = async (
  input: DashboardSettingsMutationInput,
): Promise<DashboardSettingsMutationSuccess> => {
  const response = await dashboardClient.dashboard.api.settings.$put({ json: input });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(result.ok ? `save settings failed: ${response.status}` : result.error.code);
  return result;
};

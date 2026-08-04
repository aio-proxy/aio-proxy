import type {
  DashboardSettingsMutationInput,
  DashboardSettingsMutationResponse,
  DashboardSettingsView,
} from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { createDashboardClient } from '@/lib/dashboard-client';

const dashboardClient = createDashboardClient();

export const settingsQueryKey = ['settings'] as const;

export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: settingsQueryKey,
    queryFn: async (): Promise<DashboardSettingsView> => {
      const response = await dashboardClient.dashboard.api.settings.$get();
      if (!response.ok) throw new Error(`load settings failed: ${response.status}`);
      return response.json();
    },
  });

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

import type { DashboardReleaseView } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { createDashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

const dashboardClient = createDashboardClient();

export interface ReleaseCheck {
  readonly current: string;
  readonly latest: string;
  readonly outdated: boolean;
}

export const releaseQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.release,
    queryFn: async (): Promise<DashboardReleaseView> => {
      const response = await dashboardClient.dashboard.api.release.$get();
      if (!response.ok) throw new Error(`load release failed: ${response.status}`);
      return (await response.json()) as DashboardReleaseView;
    },
  });

export const checkLatestReleaseMutationFn = async (): Promise<ReleaseCheck> => {
  const response = await dashboardClient.dashboard.api.release.latest.$get();
  const result = await response.json();
  if ('error' in result) throw new Error(result.error.code);
  return result;
};

export const applyReleaseMutationFn = async () => {
  const response = await dashboardClient.dashboard.api.release.apply.$post();
  const result = await response.json();
  if ('error' in result) throw new Error(result.error.code);
  return result;
};

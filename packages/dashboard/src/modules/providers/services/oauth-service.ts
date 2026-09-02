import type {
  DashboardOAuthCapabilitiesResponse,
  DashboardOAuthSession,
  DashboardOAuthSessionStart,
} from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';

import { createDashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

const dashboardClient = createDashboardClient();

export const oauthCapabilitiesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.oauthCapabilities,
    queryFn: async (): Promise<DashboardOAuthCapabilitiesResponse> => {
      const response = await dashboardClient.dashboard.api.oauth.capabilities.$get();
      if (!response.ok) throw new Error(`load OAuth capabilities failed: ${response.status}`);
      return (await response.json()) as unknown as DashboardOAuthCapabilitiesResponse;
    },
  });

export const oauthSessionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.oauthSession(id),
    queryFn: async (): Promise<{ session: DashboardOAuthSession }> => {
      const response = await dashboardClient.dashboard.api.oauth.sessions[':id'].$get({ param: { id } });
      if (!response.ok) throw new Error(`load OAuth session failed: ${response.status}`);
      return response.json();
    },
    enabled: id !== '',
    // Authorization deliberately hands focus to a popup, so the dashboard tab is blurred for the whole
    // pending phase. Without this the poll stalls exactly then, and a session that only reaches
    // device_code/authorize_url after a round trip is never observed until the user comes back.
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return false;
      const status = query.state.data?.session.status;
      return status === undefined ||
        status === 'preparing' ||
        status === 'device_code' ||
        status === 'authorize_url' ||
        status === 'loopback' ||
        status === 'discovering'
        ? 500
        : false;
    },
  });

const oauthRequestError = async (response: Response, fallback: string): Promise<never> => {
  const body = (await response.json().catch(() => undefined)) as { readonly error?: unknown } | undefined;
  const detail = typeof body?.error === 'string' && body.error.trim() !== '' ? body.error : undefined;
  throw new Error(detail ?? `${fallback}: ${response.status}`);
};

export const startOAuthSession = async (
  input: DashboardOAuthSessionStart,
): Promise<{ session: DashboardOAuthSession }> => {
  const response = await dashboardClient.dashboard.api.oauth.sessions.$post({ json: input });
  if (!response.ok) return oauthRequestError(response, 'start OAuth session failed');
  return response.json();
};

export const submitOAuthCallback = async (input: { readonly id: string; readonly callbackUrl: string }) => {
  const response = await dashboardClient.dashboard.api.oauth.sessions[':id'].callback.$post({
    param: { id: input.id },
    json: { callbackUrl: input.callbackUrl },
  });
  if (!response.ok) throw new Error(`submit OAuth callback failed: ${response.status}`);
  return response.json();
};

export const cancelOAuthSession = async (id: string) => {
  const response = await dashboardClient.dashboard.api.oauth.sessions[':id'].$delete({ param: { id } });
  if (!response.ok) throw new Error(`cancel OAuth session failed: ${response.status}`);
  return response.json();
};

import type {
  DashboardOAuthCapabilitiesResponse,
  DashboardOAuthSession,
  DashboardOAuthSessionStart,
} from "@aio-proxy/types";

import { queryOptions } from "@tanstack/react-query";

import { createDashboardClient } from "@/lib/dashboard-client";

const dashboardClient = createDashboardClient();

export const oauthCapabilitiesQueryOptions = () =>
  queryOptions({
    queryKey: ["oauth-capabilities"],
    queryFn: async (): Promise<DashboardOAuthCapabilitiesResponse> => {
      const response = await dashboardClient.dashboard.api.oauth.capabilities.$get();
      if (!response.ok) throw new Error(`load OAuth capabilities failed: ${response.status}`);
      return response.json();
    },
  });

export const oauthSessionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["oauth-session", id],
    queryFn: async (): Promise<{ session: DashboardOAuthSession }> => {
      const response = await dashboardClient.dashboard.api.oauth.sessions[":id"].$get({ param: { id } });
      if (!response.ok) throw new Error(`load OAuth session failed: ${response.status}`);
      return response.json();
    },
    enabled: id !== "",
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      const status = query.state.data?.session.status;
      return status === undefined ||
        status === "preparing" ||
        status === "device_code" ||
        status === "loopback" ||
        status === "discovering"
        ? 500
        : false;
    },
  });

export const startOAuthSession = async (
  input: DashboardOAuthSessionStart,
): Promise<{ session: DashboardOAuthSession }> => {
  const response = await dashboardClient.dashboard.api.oauth.sessions.$post({ json: input });
  if (!response.ok) throw new Error(`start OAuth session failed: ${response.status}`);
  return response.json();
};

export const submitOAuthCallback = async (input: { readonly id: string; readonly callbackUrl: string }) => {
  const response = await dashboardClient.dashboard.api.oauth.sessions[":id"].callback.$post({
    param: { id: input.id },
    json: { callbackUrl: input.callbackUrl },
  });
  if (!response.ok) throw new Error(`submit OAuth callback failed: ${response.status}`);
  return response.json();
};

export const cancelOAuthSession = async (id: string) => {
  const response = await dashboardClient.dashboard.api.oauth.sessions[":id"].$delete({ param: { id } });
  if (!response.ok) throw new Error(`cancel OAuth session failed: ${response.status}`);
  return response.json();
};

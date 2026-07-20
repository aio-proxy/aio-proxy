import { queryOptions } from "@tanstack/react-query";

import { dashboardClient, setDashboardUnauthorizedHandler } from "@/lib/dashboard-client";
import { queryClient } from "@/lib/query-client";

import {
  dashboardAuthQueryKey,
  type DashboardAuthSession,
  isNotDashboardAuthQuery,
  markDashboardSessionExpired,
  setDashboardAuthSession,
} from "./auth-session-store";

setDashboardUnauthorizedHandler(markDashboardSessionExpired);

export type DashboardLoginResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "invalid" | "rate-limited" | "unavailable" | "unknown" };

export const dashboardAuthSessionQueryOptions = () =>
  queryOptions({
    queryKey: dashboardAuthQueryKey,
    queryFn: async (): Promise<DashboardAuthSession> => {
      const response = await dashboardClient.dashboard.api.auth.session.$get();
      if (!response.ok) throw new Error("Dashboard authentication status is unavailable");
      return response.json();
    },
    retry: false,
    staleTime: 0,
  });

export async function loginDashboard(password: string): Promise<DashboardLoginResult> {
  const response = await dashboardClient.dashboard.api.auth.login.$post({ json: { password } });
  if (response.status === 200) {
    setDashboardAuthSession({ status: "authenticated" });
    await queryClient.invalidateQueries({ predicate: isNotDashboardAuthQuery });
    return { ok: true };
  }
  if (response.status === 401) return { ok: false, error: "invalid" };
  if (response.status === 429) return { ok: false, error: "rate-limited" };
  if (response.status === 503) return { ok: false, error: "unavailable" };
  return { ok: false, error: "unknown" };
}

export async function logoutDashboard(): Promise<void> {
  const response = await dashboardClient.dashboard.api.auth.logout.$post();
  if (!response.ok) throw new Error("Dashboard logout failed");
  queryClient.removeQueries({ predicate: isNotDashboardAuthQuery });
  setDashboardAuthSession({ status: "unauthenticated" });
}

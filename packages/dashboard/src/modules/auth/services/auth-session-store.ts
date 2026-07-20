import { queryClient } from "@/lib/query-client";

export const dashboardAuthQueryKey = ["dashboard-auth"] as const;

export type DashboardAuthSession = {
  readonly status: "authenticated" | "disabled" | "unauthenticated" | "unavailable";
  readonly reason?: "expired";
};

export const isNotDashboardAuthQuery = (query: { readonly queryKey: readonly unknown[] }): boolean =>
  query.queryKey[0] !== dashboardAuthQueryKey[0];

export function setDashboardAuthSession(session: DashboardAuthSession): void {
  queryClient.setQueryData(dashboardAuthQueryKey, session);
}

export function markDashboardSessionExpired(): void {
  const current = queryClient.getQueryData<DashboardAuthSession>(dashboardAuthQueryKey);
  if (current?.status !== "authenticated" && current?.status !== "disabled") return;
  queryClient.removeQueries({ predicate: isNotDashboardAuthQuery });
  setDashboardAuthSession(
    current.status === "authenticated"
      ? { status: "unauthenticated", reason: "expired" }
      : { status: "unauthenticated" },
  );
}

import { queryOptions } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { dashboardClient } from "@/lib/dashboard-client";

type DashboardUsageResponse = InferResponseType<typeof dashboardClient.dashboard.api.usage.$get, 200>;

export class DashboardUsageRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Dashboard usage request failed with status ${status}`);
    this.name = "DashboardUsageRequestError";
    this.status = status;
  }
}

export type UsageQueryInput = {
  readonly limit?: number;
};

export const usageQueryOptions = (input: UsageQueryInput = {}) =>
  queryOptions({
    queryKey: ["dashboard", "usage", input.limit ?? 100],
    queryFn: () => getUsage(input),
  });

async function getUsage(input: UsageQueryInput): Promise<DashboardUsageResponse> {
  const response = await dashboardClient.dashboard.api.usage.$get({
    query: { limit: String(input.limit ?? 100) },
  });
  if (!response.ok) {
    throw new DashboardUsageRequestError(response.status);
  }
  return response.json();
}

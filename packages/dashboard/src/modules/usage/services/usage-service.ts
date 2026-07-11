import type { UsageOverviewGroupBy, UsageOverviewMetric, UsageOverviewRange } from "@aio-proxy/types";
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
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
};

export const usageQueryOptions = (input: UsageQueryInput) =>
  queryOptions({
    queryKey: ["dashboard", "usage", input.range, input.metric, input.groupBy],
    queryFn: () => getUsage(input),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

async function getUsage(input: UsageQueryInput): Promise<DashboardUsageResponse> {
  const response = await dashboardClient.dashboard.api.usage.$get({
    query: { range: input.range, metric: input.metric, groupBy: input.groupBy },
  });
  if (!response.ok) {
    throw new DashboardUsageRequestError(response.status);
  }
  return response.json();
}

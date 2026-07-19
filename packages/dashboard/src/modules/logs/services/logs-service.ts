import type { InferResponseType } from "hono/client";

import { queryOptions } from "@tanstack/react-query";

import { dashboardClient } from "@/lib/dashboard-client";

import type { LogsSearch } from "../logs-search";

type DashboardLogsResponse = InferResponseType<typeof dashboardClient.dashboard.api.logs.$get, 200>;

export class DashboardLogsRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard logs request failed with status ${status}`);
    this.name = "DashboardLogsRequestError";
  }
}

export const logsQueryOptions = (search: LogsSearch, autoRefresh: boolean) =>
  queryOptions({
    queryKey: ["dashboard", "logs", search],
    queryFn: () => getLogs(search),
    refetchInterval: autoRefresh && search.page === 1 ? 5_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });

export async function getLogs(search: LogsSearch): Promise<DashboardLogsResponse> {
  const response = await dashboardClient.dashboard.api.logs.$get({
    query: {
      page: String(search.page),
      pageSize: String(search.pageSize),
      startedAfter: search.startedAfter,
      completedBefore: search.completedBefore,
      ...(search.requestId === undefined ? {} : { requestId: search.requestId }),
      ...(search.outcome === undefined ? {} : { outcome: search.outcome }),
      ...(search.inboundProtocol === undefined ? {} : { inboundProtocol: search.inboundProtocol }),
      ...(search.requestedModelId === undefined ? {} : { requestedModelId: search.requestedModelId }),
      ...(search.finalProviderId === undefined ? {} : { finalProviderId: search.finalProviderId }),
      ...(search.finalModelId === undefined ? {} : { finalModelId: search.finalModelId }),
      ...(search.finalStatusCode === undefined ? {} : { finalStatusCode: String(search.finalStatusCode) }),
    },
  });
  if (!response.ok) throw new DashboardLogsRequestError(response.status);
  return response.json();
}

export type LogsData = Awaited<ReturnType<typeof getLogs>>;

import { useQuery } from "@tanstack/react-query";

import type { LogsSearch } from "../logs-search";

import { logsQueryOptions } from "../services/logs-service";

export const useLogsQuery = (search: LogsSearch, autoRefresh: boolean) =>
  useQuery(logsQueryOptions(search, autoRefresh));

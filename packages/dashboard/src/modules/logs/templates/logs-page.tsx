import type { DashboardRequestLog } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";
import { useState } from "react";

import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

import { LogDetailDrawer } from "../components/log-detail-drawer";
import { LogsFilters } from "../components/logs-filters";
import { LogsTable } from "../components/logs-table";
import { useLogsQuery } from "../hooks/use-logs-query";
import { createDefaultLogsSearch, type LogsSearch } from "../logs-search";

type Props = { readonly search: LogsSearch; readonly onSearchChange: (search: LogsSearch) => void };

export const LogsPage: React.FC<Props> = ({ search, onSearchChange }) => {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<DashboardRequestLog>();
  const query = useLogsQuery(search, autoRefresh);

  return (
    <PageContainer title={m["dashboard.logs.title"]()}>
      <div className="space-y-4">
        <LogsFilters
          key={`${search.startedAfter}-${search.completedBefore}-${search.pageSize}`}
          search={search}
          autoRefresh={autoRefresh}
          refreshing={query.isFetching}
          onChange={onSearchChange}
          onAutoRefresh={setAutoRefresh}
          onRefresh={() => void query.refetch()}
        />
        {query.isLoading ? (
          <div className="space-y-2" role="status" aria-label={m["dashboard.logs.loading"]()}>
            {["a", "b", "c", "d", "e", "f"].map((key) => (
              <Skeleton className="h-12 w-full" key={key} />
            ))}
          </div>
        ) : query.isError ? (
          <Empty>
            <EmptyTitle>{m["dashboard.logs.error_title"]()}</EmptyTitle>
            <EmptyDescription>{m["dashboard.logs.error_description"]()}</EmptyDescription>
            <Button onClick={() => void query.refetch()}>{m["dashboard.logs.refresh"]()}</Button>
          </Empty>
        ) : query.data?.items.length === 0 ? (
          <Empty>
            <EmptyTitle>{m["dashboard.logs.empty_title"]()}</EmptyTitle>
            <EmptyDescription>{m["dashboard.logs.empty_description"]()}</EmptyDescription>
            <Button onClick={() => onSearchChange(createDefaultLogsSearch())}>{m["dashboard.logs.reset"]()}</Button>
          </Empty>
        ) : query.data ? (
          <LogsTable data={query.data} search={search} onSearchChange={onSearchChange} onSelect={setSelected} />
        ) : (
          <Empty />
        )}
      </div>
      <LogDetailDrawer log={selected} onClose={() => setSelected(undefined)} />
    </PageContainer>
  );
};

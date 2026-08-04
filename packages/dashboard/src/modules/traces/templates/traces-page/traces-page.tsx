import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Empty, EmptyDescription, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { TracesFilterRail } from '../../components/traces-filter-rail';
import { TracesTable } from '../../components/traces-table';
import { useTracesQuery } from '../../hooks/use-traces-query';
import { createDefaultTraceSearch, type TraceSearch } from '../../trace-search';

interface TracesPageProps {
  readonly search: TraceSearch;
  readonly onSearchChange: (search: TraceSearch) => void;
  readonly onTraceSelect: (traceId: string) => void;
}

export const TracesPage: React.FC<TracesPageProps> = ({ search, onSearchChange, onTraceSelect }) => {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const query = useTracesQuery(search, autoRefresh);

  return (
    <PageContainer title={m['dashboard.traces.title']()}>
      <div className="traces-filter-workbench">
        <TracesFilterRail
          search={search}
          autoRefresh={autoRefresh}
          refreshing={query.isFetching}
          onSearchChange={onSearchChange}
          onAutoRefresh={setAutoRefresh}
          onRefresh={() => void query.refetch()}
        />
        <Card className="traces-filter-results">
          <CardContent>
            {query.isLoading ? (
              <div className="space-y-2" role="status" aria-label={m['dashboard.traces.loading']()}>
                {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                  <Skeleton className="h-12 w-full" key={key} />
                ))}
              </div>
            ) : query.isError ? (
              <Empty>
                <EmptyTitle>{m['dashboard.traces.error_title']()}</EmptyTitle>
                <EmptyDescription>{m['dashboard.traces.error_description']()}</EmptyDescription>
                <Button onClick={() => void query.refetch()}>{m['dashboard.traces.refresh']()}</Button>
              </Empty>
            ) : query.data?.items.length === 0 ? (
              <Empty>
                <EmptyTitle>{m['dashboard.traces.empty_title']()}</EmptyTitle>
                <EmptyDescription>{m['dashboard.traces.empty_description']()}</EmptyDescription>
                <Button onClick={() => onSearchChange(createDefaultTraceSearch())}>
                  {m['dashboard.traces.reset']()}
                </Button>
              </Empty>
            ) : query.data ? (
              <TracesTable data={query.data} search={search} onSearchChange={onSearchChange} onSelect={onTraceSelect} />
            ) : (
              <Empty />
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
};

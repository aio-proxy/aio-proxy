import { m } from '@aio-proxy/i18n';
import { DashboardTracePageSizeSchema } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card } from '@aio-proxy/ui/components/card';
import { Empty, EmptyDescription, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Sidebar, SidebarInset, SidebarProvider, SidebarTrigger } from '@aio-proxy/ui/components/sidebar';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useEffect, useRef, useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { TracesFilterRail } from '../../components/traces-filter-rail';
import { TracesTable } from '../../components/traces-table';
import { useTracesQuery } from '../../hooks/use-traces-query';
import { createDefaultTraceSearch, type TraceSearch, withTraceFilters } from '../../lib/trace-search';
import { DashboardTracesRequestError } from '../../services/traces-service';

type TracesData = NonNullable<ReturnType<typeof useTracesQuery>['data']>;

interface TracesPageProps {
  readonly search: TraceSearch;
  readonly onSearchChange: (search: TraceSearch, options?: { readonly replace?: boolean }) => void;
  readonly onTraceSelect: (traceId: string) => void;
}

export const TracesPage: React.FC<TracesPageProps> = ({ search, onSearchChange, onTraceSelect }) => {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [renderedData, setRenderedData] = useState<TracesData>();
  const [newItemsCount, setNewItemsCount] = useState(0);
  const searchKey = JSON.stringify(search);
  const [bufferSearchKey, setBufferSearchKey] = useState(searchKey);
  const activeSearchKeyRef = useRef(searchKey);
  const canonicalizedSearchKeyRef = useRef<string | undefined>(undefined);
  const renderedDataRef = useRef<TracesData | undefined>(undefined);
  const latestFirstPageRef = useRef<TracesData | undefined>(undefined);
  const query = useTracesQuery(search, autoRefresh);

  if (activeSearchKeyRef.current !== searchKey) {
    activeSearchKeyRef.current = searchKey;
    canonicalizedSearchKeyRef.current = undefined;
    renderedDataRef.current = undefined;
    latestFirstPageRef.current = undefined;
  }

  useEffect(() => {
    if (query.data === undefined || query.isError) return;

    setBufferSearchKey(searchKey);

    if (query.isPlaceholderData) {
      setRenderedData(undefined);
      setNewItemsCount(0);
      return;
    }

    if (
      search.pageToken !== undefined &&
      query.data.prevPageToken === undefined &&
      canonicalizedSearchKeyRef.current !== searchKey
    ) {
      canonicalizedSearchKeyRef.current = searchKey;
      const { pageToken: _pageToken, ...latestSearch } = search;
      onSearchChange(latestSearch, { replace: true });
      return;
    }

    if (search.pageToken !== undefined) {
      renderedDataRef.current = query.data;
      latestFirstPageRef.current = undefined;
      setRenderedData(query.data);
      setNewItemsCount(0);
      return;
    }

    const current = renderedDataRef.current ?? query.data;
    const renderedIds = new Set(current.items.map((item) => item.traceId));
    const unseenCount = query.data.items.filter((item) => !renderedIds.has(item.traceId)).length;
    latestFirstPageRef.current = query.data;
    setNewItemsCount(unseenCount);

    if (unseenCount === 0) {
      renderedDataRef.current = query.data;
      setRenderedData(query.data);
    }
  }, [onSearchChange, query.data, query.isError, query.isPlaceholderData, search, search.pageToken, searchKey]);

  const bufferIsActive = bufferSearchKey === searchKey;
  const visibleData = bufferIsActive ? (renderedData ?? query.data) : query.data;

  return (
    <PageContainer
      title={m['dashboard.traces.title']()}
      breadcrumbs={[{ label: m['dashboard.menus.observability']() }, { label: m['dashboard.traces.title']() }]}
      classNames={{
        root: 'flex flex-col overflow-hidden',
        main: 'min-h-0 flex-1 overflow-hidden',
      }}
    >
      <Card size="sm" className="h-full w-full py-0">
        <SidebarProvider defaultOpen={false} className="relative h-full min-h-0 w-full overflow-hidden">
          <Sidebar className="absolute! inset-y-0! h-full! border-r" aria-label={m['dashboard.traces.filters']()}>
            <TracesFilterRail
              search={search}
              autoRefresh={autoRefresh}
              refreshing={query.isFetching}
              onSearchChange={onSearchChange}
              onAutoRefresh={setAutoRefresh}
              onRefresh={() => void query.refetch()}
            />
          </Sidebar>
          <SidebarInset className="min-h-0 min-w-0">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-12 shrink-0 items-center border-b px-3">
                <SidebarTrigger aria-label={m['dashboard.traces.filters']()} />
              </div>
              <div className="min-h-0 min-w-0 flex-1 pb-3 sm:pb-4">
                {query.isLoading ? (
                  <div className="mx-3 space-y-2 sm:mx-4" role="status" aria-label={m['dashboard.traces.loading']()}>
                    {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                      <Skeleton className="h-12 w-full" key={key} />
                    ))}
                  </div>
                ) : query.isError ? (
                  <Empty>
                    <EmptyTitle>{m['dashboard.traces.error_title']()}</EmptyTitle>
                    <EmptyDescription>{m['dashboard.traces.error_description']()}</EmptyDescription>
                    {search.pageToken !== undefined &&
                    query.error instanceof DashboardTracesRequestError &&
                    query.error.status === 400 ? (
                      <Button
                        onClick={() => {
                          const { pageToken: _pageToken, ...latestSearch } = search;
                          onSearchChange(latestSearch, { replace: true });
                        }}
                      >
                        {m['dashboard.traces.reset']()}
                      </Button>
                    ) : (
                      <Button onClick={() => void query.refetch()}>{m['dashboard.traces.refresh']()}</Button>
                    )}
                  </Empty>
                ) : query.data?.items.length === 0 ? (
                  <Empty>
                    <EmptyTitle>{m['dashboard.traces.empty_title']()}</EmptyTitle>
                    <EmptyDescription>{m['dashboard.traces.empty_description']()}</EmptyDescription>
                    <Button onClick={() => onSearchChange(createDefaultTraceSearch())}>
                      {m['dashboard.traces.reset']()}
                    </Button>
                  </Empty>
                ) : visibleData ? (
                  <TracesTable
                    data={visibleData}
                    isFetching={query.isFetching || query.isPlaceholderData}
                    pageSize={search.pageSize}
                    newItemsCount={search.pageToken === undefined && bufferIsActive ? newItemsCount : 0}
                    onAcceptNewItems={() => {
                      const latest = latestFirstPageRef.current;
                      if (latest === undefined) return;
                      renderedDataRef.current = latest;
                      setRenderedData(latest);
                      setNewItemsCount(0);
                    }}
                    onShowSizeChange={(pageSize) =>
                      onSearchChange(
                        withTraceFilters(search, { pageSize: DashboardTracePageSizeSchema.parse(pageSize) }),
                      )
                    }
                    onPrevious={(pageToken) => onSearchChange({ ...search, pageToken })}
                    onNext={(pageToken) => onSearchChange({ ...search, pageToken })}
                    onSelect={onTraceSelect}
                  />
                ) : (
                  <Empty />
                )}
              </div>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </Card>
    </PageContainer>
  );
};

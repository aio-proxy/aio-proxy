import { m } from '@aio-proxy/i18n';
import { DashboardTracePageSizeSchema } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card } from '@aio-proxy/ui/components/card';
import { Empty, EmptyDescription, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@aio-proxy/ui/components/sidebar';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useEffect, useReducer, useRef, useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { TracesFilters } from '../../components/traces-filters';
import { TracesTable } from '../../components/traces-table';
import { useTracesQuery } from '../../hooks/use-traces-query';
import { createDefaultTraceSearch, type TraceSearch, withTraceFilters } from '../../lib/trace-search';
import { DashboardTracesRequestError } from '../../services/traces-service';

type TracesData = NonNullable<ReturnType<typeof useTracesQuery>['data']>;

interface TraceBufferState {
  readonly searchKey: string;
  readonly renderedData: TracesData | undefined;
  readonly newItemsCount: number;
}

type TraceBufferAction =
  | { readonly type: 'reset'; readonly searchKey: string }
  | { readonly type: 'replace'; readonly searchKey: string; readonly data: TracesData }
  | { readonly type: 'set-new-items'; readonly searchKey: string; readonly count: number };

const traceBufferReducer = (state: TraceBufferState, action: TraceBufferAction): TraceBufferState => {
  if (action.type === 'reset') return { searchKey: action.searchKey, renderedData: undefined, newItemsCount: 0 };
  if (action.type === 'replace') return { searchKey: action.searchKey, renderedData: action.data, newItemsCount: 0 };
  return { ...state, searchKey: action.searchKey, newItemsCount: action.count };
};

interface TracesPageProps {
  readonly search: TraceSearch;
  readonly onSearchChange: (search: TraceSearch, options?: { readonly replace?: boolean }) => void;
  readonly onTraceSelect: (traceId: string) => void;
}

export const TracesPage: React.FC<TracesPageProps> = ({ search, onSearchChange, onTraceSelect }) => {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const searchKey = JSON.stringify(search);
  const [buffer, dispatchBuffer] = useReducer(traceBufferReducer, searchKey, (initialSearchKey) => ({
    searchKey: initialSearchKey,
    renderedData: undefined,
    newItemsCount: 0,
  }));
  const activeSearchKeyRef = useRef(searchKey);
  const canonicalizedSearchKeyRef = useRef<string | undefined>(undefined);
  const renderedDataRef = useRef<TracesData | undefined>(undefined);
  const latestFirstPageRef = useRef<TracesData | undefined>(undefined);
  const query = useTracesQuery(search, autoRefresh);

  useEffect(() => {
    if (query.data === undefined || query.isError) return;

    if (activeSearchKeyRef.current !== searchKey) {
      activeSearchKeyRef.current = searchKey;
      canonicalizedSearchKeyRef.current = undefined;
      renderedDataRef.current = undefined;
      latestFirstPageRef.current = undefined;
    }

    if (query.isPlaceholderData) {
      dispatchBuffer({ type: 'reset', searchKey });
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
      dispatchBuffer({ type: 'replace', searchKey, data: query.data });
      return;
    }

    const current = renderedDataRef.current ?? query.data;
    const renderedIds = new Set(current.items.map((item) => item.traceId));
    const unseenCount = query.data.items.filter((item) => !renderedIds.has(item.traceId)).length;
    latestFirstPageRef.current = query.data;
    dispatchBuffer({ type: 'set-new-items', searchKey, count: unseenCount });

    if (unseenCount === 0) {
      renderedDataRef.current = query.data;
      dispatchBuffer({ type: 'replace', searchKey, data: query.data });
    }
  }, [onSearchChange, query.data, query.isError, query.isPlaceholderData, search, search.pageToken, searchKey]);

  const bufferIsActive = buffer.searchKey === searchKey;
  const visibleData = bufferIsActive ? (buffer.renderedData ?? query.data) : query.data;
  const loading = query.isLoading || (query.isPlaceholderData && search.pageToken === undefined);

  return (
    <PageContainer
      title={m['dashboard.traces.title']()}
      breadcrumbs={[{ label: m['dashboard.menus.observability']() }, { label: m['dashboard.traces.title']() }]}
      classNames={{
        root: cn('flex flex-col overflow-hidden'),
        main: cn('min-h-0 flex-1 overflow-hidden'),
      }}
    >
      <Card size="sm" className="h-full w-full py-0">
        <SidebarProvider defaultOpen={false} className="relative h-full min-h-0 w-full overflow-hidden">
          <TracesFilters
            search={search}
            autoRefresh={autoRefresh}
            refreshing={query.isFetching}
            onChange={onSearchChange}
            onAutoRefresh={setAutoRefresh}
            onRefresh={() => void query.refetch()}
          />
          <SidebarInset className="min-h-0 min-w-0">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-12 shrink-0 items-center border-b px-3">
                <SidebarTrigger aria-label={m['dashboard.traces.filters']()} />
              </div>
              <div className="min-h-0 min-w-0 flex-1 pb-3 sm:pb-4">
                {loading && (
                  <div className="mx-3 space-y-2 sm:mx-4" role="status" aria-label={m['dashboard.traces.loading']()}>
                    {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                      <Skeleton className="h-12 w-full" key={key} />
                    ))}
                  </div>
                )}
                {!loading && query.isError && (
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
                )}
                {!loading && !query.isError && query.data?.items.length === 0 && (
                  <Empty>
                    <EmptyTitle>{m['dashboard.traces.empty_title']()}</EmptyTitle>
                    <EmptyDescription>{m['dashboard.traces.empty_description']()}</EmptyDescription>
                    <Button onClick={() => onSearchChange(createDefaultTraceSearch())}>
                      {m['dashboard.traces.reset']()}
                    </Button>
                  </Empty>
                )}
                {!loading && !query.isError && query.data?.items.length !== 0 && visibleData && (
                  <TracesTable
                    data={visibleData}
                    isFetching={query.isFetching || query.isPlaceholderData}
                    pageSize={search.pageSize}
                    newItemsCount={search.pageToken === undefined && bufferIsActive ? buffer.newItemsCount : 0}
                    onAcceptNewItems={() => {
                      const latest = latestFirstPageRef.current;
                      if (latest === undefined) return;
                      renderedDataRef.current = latest;
                      dispatchBuffer({ type: 'replace', searchKey, data: latest });
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
                )}
                {!loading && !query.isError && query.data?.items.length !== 0 && !visibleData && <Empty />}
              </div>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </Card>
    </PageContainer>
  );
};

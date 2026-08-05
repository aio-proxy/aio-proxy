import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card } from '@aio-proxy/ui/components/card';
import { Empty, EmptyDescription, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@aio-proxy/ui/components/sheet';
import { Sidebar } from '@aio-proxy/ui/components/sidebar';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { TracesFilterRail } from '../../components/traces-filter-rail';
import { TracesTable } from '../../components/traces-table';
import { useTracesQuery } from '../../hooks/use-traces-query';
import { createDefaultTraceSearch, type TraceSearch } from '../../lib/trace-search';
import { DashboardTracesRequestError } from '../../services/traces-service';

type TracesData = NonNullable<ReturnType<typeof useTracesQuery>['data']>;

interface TracesPageProps {
  readonly search: TraceSearch;
  readonly onSearchChange: (search: TraceSearch) => void;
  readonly onTraceSelect: (traceId: string) => void;
}

export const TracesPage: React.FC<TracesPageProps> = ({ search, onSearchChange, onTraceSelect }) => {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [renderedData, setRenderedData] = useState<TracesData>();
  const [newItemsCount, setNewItemsCount] = useState(0);
  const searchKey = JSON.stringify(search);
  const [bufferSearchKey, setBufferSearchKey] = useState(searchKey);
  const activeSearchKeyRef = useRef(searchKey);
  const renderedDataRef = useRef<TracesData | undefined>(undefined);
  const latestFirstPageRef = useRef<TracesData | undefined>(undefined);
  const query = useTracesQuery(search, autoRefresh);
  const mobile = useIsMobile();

  if (activeSearchKeyRef.current !== searchKey) {
    activeSearchKeyRef.current = searchKey;
    renderedDataRef.current = undefined;
    latestFirstPageRef.current = undefined;
  }

  useEffect(() => {
    if (query.data === undefined) return;

    setBufferSearchKey(searchKey);

    if (query.isPlaceholderData) {
      setRenderedData(undefined);
      setNewItemsCount(0);
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
  }, [query.data, query.isPlaceholderData, search.pageToken, searchKey]);

  const bufferIsActive = bufferSearchKey === searchKey;
  const visibleData = bufferIsActive ? (renderedData ?? query.data) : query.data;
  const filters = (
    <TracesFilterRail
      search={search}
      autoRefresh={autoRefresh}
      refreshing={query.isFetching}
      onSearchChange={onSearchChange}
      onAutoRefresh={setAutoRefresh}
      onRefresh={() => void query.refetch()}
    />
  );

  return (
    <PageContainer
      title={m['dashboard.traces.title']()}
      breadcrumbs={[{ label: m['dashboard.menus.observability']() }, { label: m['dashboard.traces.title']() }]}
    >
      <Card size="sm" className="py-0">
        <div className="flex min-h-[36rem] lg:min-h-[calc(100dvh-10rem)]">
          {!mobile && filtersOpen ? (
            <Sidebar collapsible="none" className="shrink-0 border-r" aria-label={m['dashboard.traces.filters']()}>
              {filters}
            </Sidebar>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 items-center border-b px-3">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={m['dashboard.traces.filters']()}
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal />
              </Button>
            </div>
            <div className="min-w-0 flex-1 overflow-auto px-3 pb-3 sm:px-4 sm:pb-4">
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
                  {search.pageToken !== undefined &&
                  query.error instanceof DashboardTracesRequestError &&
                  query.error.status === 400 ? (
                    <Button
                      onClick={() => {
                        const { pageToken: _pageToken, ...latestSearch } = search;
                        onSearchChange(latestSearch);
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
                  newItemsCount={search.pageToken === undefined && bufferIsActive ? newItemsCount : 0}
                  onAcceptNewItems={() => {
                    const latest = latestFirstPageRef.current;
                    if (latest === undefined) return;
                    renderedDataRef.current = latest;
                    setRenderedData(latest);
                    setNewItemsCount(0);
                  }}
                  onPrevious={(pageToken) => onSearchChange({ ...search, pageToken })}
                  onNext={(pageToken) => onSearchChange({ ...search, pageToken })}
                  onSelect={onTraceSelect}
                />
              ) : (
                <Empty />
              )}
            </div>
          </div>
        </div>
        {mobile ? (
          <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
            <SheetContent side="left" className="p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{m['dashboard.traces.filters']()}</SheetTitle>
              </SheetHeader>
              {filters}
            </SheetContent>
          </Sheet>
        ) : null}
      </Card>
    </PageContainer>
  );
};

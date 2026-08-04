import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { Empty, EmptyDescription, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useEffect, useRef, useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { TracesFilterRail } from '../../components/traces-filter-rail';
import { TracesTable } from '../../components/traces-table';
import { useTracesQuery } from '../../hooks/use-traces-query';
import { createDefaultTraceSearch, type TraceSearch } from '../../trace-search';

type TracesData = NonNullable<ReturnType<typeof useTracesQuery>['data']>;

interface TracesPageProps {
  readonly search: TraceSearch;
  readonly onSearchChange: (search: TraceSearch) => void;
  readonly onTraceSelect: (traceId: string) => void;
}

export const TracesPage: React.FC<TracesPageProps> = ({ search, onSearchChange, onTraceSelect }) => {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [renderedData, setRenderedData] = useState<TracesData>();
  const [newItemsCount, setNewItemsCount] = useState(0);
  const searchKey = JSON.stringify(search);
  const [bufferSearchKey, setBufferSearchKey] = useState(searchKey);
  const activeSearchKeyRef = useRef(searchKey);
  const renderedDataRef = useRef<TracesData | undefined>(undefined);
  const latestFirstPageRef = useRef<TracesData | undefined>(undefined);
  const query = useTracesQuery(search, autoRefresh);

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

    if (search.page !== 1) {
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
  }, [query.data, query.isPlaceholderData, search.page, searchKey]);

  const bufferIsActive = bufferSearchKey === searchKey;
  const visibleData = bufferIsActive ? (renderedData ?? query.data) : query.data;

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
            ) : visibleData ? (
              <TracesTable
                data={visibleData}
                search={search}
                isFetching={query.isFetching}
                isPlaceholderData={query.isPlaceholderData}
                newItemsCount={search.page === 1 && bufferIsActive ? newItemsCount : 0}
                onAcceptNewItems={() => {
                  const latest = latestFirstPageRef.current;
                  if (latest === undefined) return;
                  renderedDataRef.current = latest;
                  setRenderedData(latest);
                  setNewItemsCount(0);
                }}
                onLoadOlder={() => {
                  if (query.isFetching || query.isPlaceholderData || search.page >= visibleData.pageCount) {
                    return;
                  }
                  onSearchChange({ ...search, page: search.page + 1 });
                }}
                onSelect={onTraceSelect}
              />
            ) : (
              <Empty />
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
};

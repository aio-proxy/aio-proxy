import { m } from '@aio-proxy/i18n';
import { useNavigate } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageContainer } from '@/components/page-container';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';

import { SpanDetailPanel } from '../../components/span-detail-panel';
import { SpanWaterfall } from '../../components/span-waterfall';
import { TraceSummary } from '../../components/trace-summary';
import { useTraceQuery } from '../../hooks/use-trace-query';
import { DashboardTracesRequestError } from '../../services/traces-service';
import { createDefaultTraceSearch } from '../../trace-search';

interface TraceDetailPageProps {
  readonly traceId: string;
}

export const TraceDetailPage: React.FC<TraceDetailPageProps> = ({ traceId }) => {
  const navigate = useNavigate();
  const query = useTraceQuery(traceId);
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  const selectedSpan =
    query.data?.spans.find((span) => span.spanId === selectedSpanId) ??
    query.data?.spans.find((span) => span.spanId === query.data?.trace.rootSpanId) ??
    query.data?.spans[0];

  useEffect(() => {
    if (query.data === undefined || query.data.spans.some((span) => span.spanId === selectedSpanId)) return;
    setSelectedSpanId(
      query.data.spans.find((span) => span.spanId === query.data?.trace.rootSpanId)?.spanId ??
        query.data.spans[0]?.spanId,
    );
  }, [query.data, selectedSpanId]);

  const refresh = (
    <Button variant="outline" onClick={() => void query.refetch()}>
      <RefreshCw />
      {m['dashboard.traces.refresh']()}
    </Button>
  );

  if (query.isLoading) {
    return (
      <PageContainer title={m['dashboard.traces.detail_title']()} subtitle={traceId} extra={refresh} backTo="/traces">
        <div className="space-y-3" role="status" aria-label={m['dashboard.traces.detail_loading']()}>
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </PageContainer>
    );
  }

  if (query.isError || query.data === undefined) {
    const notFound = query.error instanceof DashboardTracesRequestError && query.error.status === 404;
    return (
      <PageContainer title={m['dashboard.traces.detail_title']()} subtitle={traceId} extra={refresh} backTo="/traces">
        <Empty>
          <EmptyTitle>
            {notFound ? m['dashboard.traces.not_found_title']() : m['dashboard.traces.detail_error_title']()}
          </EmptyTitle>
          <EmptyDescription>
            {notFound
              ? m['dashboard.traces.not_found_description']()
              : m['dashboard.traces.detail_error_description']()}
          </EmptyDescription>
          <Button onClick={() => void query.refetch()}>{m['dashboard.traces.refresh']()}</Button>
        </Empty>
      </PageContainer>
    );
  }

  const { trace, spans } = query.data;

  return (
    <PageContainer
      title={m['dashboard.traces.detail_title']()}
      subtitle={trace.traceId}
      extra={refresh}
      backTo="/traces"
    >
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)]">
        <div className="min-w-0 space-y-4">
          <TraceSummary
            trace={trace}
            onSessionSelect={(session) =>
              void navigate({
                to: '/traces',
                search: {
                  ...createDefaultTraceSearch(),
                  page: 1,
                  sessionSource: session.source,
                  sessionId: session.id,
                },
              })
            }
          />
          <SpanWaterfall spans={spans} selectedSpanId={selectedSpan?.spanId} onSelect={setSelectedSpanId} />
        </div>
        <SpanDetailPanel span={selectedSpan} />
      </div>
    </PageContainer>
  );
};

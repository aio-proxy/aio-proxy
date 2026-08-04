import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty, EmptyDescription, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { toast } from '@aio-proxy/ui/components/toast';
import { useNavigate } from '@tanstack/react-router';
import { Copy, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { TraceContextRail } from '../../components/trace-context-rail';
import { TraceDetailTabs } from '../../components/trace-detail-tabs';
import { TraceStatus } from '../../components/trace-status';
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
  const breadcrumbs = [
    { label: m['dashboard.menus.observability']() },
    { label: m['dashboard.menus.traces'](), to: '/traces' as const },
  ];

  if (query.isLoading) {
    return (
      <PageContainer title={traceId} extra={refresh} breadcrumbs={breadcrumbs}>
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
      <PageContainer title={traceId} extra={refresh} breadcrumbs={breadcrumbs}>
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

  const { trace } = query.data;
  const copyTraceId = async () => {
    try {
      await navigator.clipboard.writeText(trace.traceId);
      toast.add({ type: 'success', title: m['dashboard.traces.trace_id_copied']() });
    } catch {
      toast.add({ type: 'error', title: m['dashboard.traces.trace_id_copy_failed']() });
    }
  };

  return (
    <PageContainer
      title={trace.traceId}
      subtitle={<TraceStatus item={trace} />}
      breadcrumbs={breadcrumbs}
      extra={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void copyTraceId()}>
            <Copy />
            {m['dashboard.traces.copy_trace_id']()}
          </Button>
          {refresh}
        </div>
      }
    >
      <div
        className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(16rem,0.32fr)_minmax(0,1fr)]"
        data-testid="trace-detail-layout"
      >
        <TraceContextRail
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
        <TraceDetailTabs detail={query.data} selectedSpan={selectedSpan} onSpanSelect={setSelectedSpanId} />
      </div>
    </PageContainer>
  );
};

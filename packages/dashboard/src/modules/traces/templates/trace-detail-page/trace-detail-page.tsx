import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty, EmptyDescription, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { toast } from '@aio-proxy/ui/components/toast';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { PageContainer } from '@/components/page-container';
import { queryKeys } from '@/lib/query-keys';

import { TraceDetailTabs } from '../../components/trace-detail-tabs';
import { TraceStatus } from '../../components/trace-status';
import { useTracePercentileQuery } from '../../hooks/use-trace-percentile-query';
import { useTraceQuery } from '../../hooks/use-trace-query';
import { createDefaultTraceSearch, withTraceFilters } from '../../lib/trace-search';
import { DashboardTracesRequestError } from '../../services/traces-service';

interface TraceDetailPageProps {
  readonly traceId: string;
}

export const TraceDetailPage: React.FC<TraceDetailPageProps> = ({ traceId }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useTraceQuery(traceId);
  const percentileQuery = useTracePercentileQuery(traceId, query.data?.trace.endedAt != null);
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  // 面包屑已经是追踪 ID。标题用根操作（POST /v1/responses），加载或失败时还没有这条名字。
  const rootSpanName = query.data?.spans.find((span) => span.spanId === query.data?.trace.rootSpanId)?.name;
  const title = rootSpanName ?? m['dashboard.traces.detail_title']();
  const selectedSpan =
    query.data?.spans.find((span) => span.spanId === selectedSpanId) ??
    query.data?.spans.find((span) => span.spanId === query.data?.trace.rootSpanId) ??
    query.data?.spans[0];
  // 详情、分位、抓包共用 `trace(traceId)` 前缀。只 refetch 详情的话，
  // 请求/响应还停在第一次打开时缓存的半截日志。
  const refreshAll = () => void queryClient.invalidateQueries({ queryKey: queryKeys.trace(traceId) });

  const refresh = (
    <Button variant="outline" onClick={refreshAll}>
      <RefreshCw />
      {m['dashboard.traces.refresh']()}
    </Button>
  );
  const breadcrumbs = [
    { label: m['dashboard.menus.observability']() },
    { label: m['dashboard.menus.traces'](), to: '/traces' as const },
    {
      label: (
        <span className="flex flex-wrap gap-1">
          {traceId} {!!query.data?.trace && <TraceStatus item={query.data?.trace} />}
        </span>
      ),
    },
  ] as const;

  if (query.isLoading) {
    return (
      <PageContainer title={title} extra={refresh} breadcrumbs={breadcrumbs}>
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
      <PageContainer title={title} extra={refresh} breadcrumbs={breadcrumbs}>
        <Empty>
          <EmptyTitle>
            {notFound ? m['dashboard.traces.not_found_title']() : m['dashboard.traces.detail_error_title']()}
          </EmptyTitle>
          <EmptyDescription>
            {notFound
              ? m['dashboard.traces.not_found_description']()
              : m['dashboard.traces.detail_error_description']()}
          </EmptyDescription>
          <Button onClick={refreshAll}>{m['dashboard.traces.refresh']()}</Button>
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
      title={title}
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
      <TraceDetailTabs
        detail={query.data}
        selectedSpan={selectedSpan}
        comparison={percentileQuery.data?.comparison}
        onSpanSelect={setSelectedSpanId}
        // 详情路由没有列表的 search。区间按这条调用链的当地日，否则历史详情会筛到今天、把自己筛没。
        onFilter={(patch) =>
          void navigate({
            to: '/traces',
            search: withTraceFilters(createDefaultTraceSearch(new Date(trace.startedAt)), patch),
          })
        }
      />
    </PageContainer>
  );
};

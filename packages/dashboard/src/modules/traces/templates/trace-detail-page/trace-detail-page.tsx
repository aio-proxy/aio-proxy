import { m } from '@aio-proxy/i18n';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { PageContainer } from '@/components/page-container';
import { ProtocolLabel } from '@/components/protocol-label';
import { TokenCount } from '@/components/token-count';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';

import { renderTraceStatus, TraceSpansTable } from '../../components/trace-spans-table';
import { useTraceQuery } from '../../hooks/use-trace-query';
import { DashboardTracesRequestError } from '../../services/traces-service';
import { displayTotalTokens, formatTraceCost, formatTraceDuration } from '../../trace-formatters';

interface TraceDetailPageProps {
  readonly traceId: string;
}

export const TraceDetailPage: React.FC<TraceDetailPageProps> = ({ traceId }) => {
  const query = useTraceQuery(traceId);
  const refresh = (
    <Button variant="outline" onClick={() => void query.refetch()}>
      <RefreshCw />
      {m['dashboard.traces.refresh']()}
    </Button>
  );

  if (query.isLoading) {
    return (
      <PageContainer title={m['dashboard.traces.detail_title']()} subtitle={traceId} extra={refresh}>
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
      <PageContainer title={m['dashboard.traces.detail_title']()} subtitle={traceId} extra={refresh}>
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
  const missing = m['dashboard.traces.not_available']();
  const summaryRows: readonly (readonly [string, ReactNode])[] = [
    [m['dashboard.traces.trace_id'](), trace.traceId],
    [m['dashboard.traces.root_span_id'](), trace.rootSpanId],
    [m['dashboard.traces.request_id'](), trace.requestId],
    [m['dashboard.traces.status'](), renderTraceStatus(trace)],
    [m['dashboard.traces.session_source'](), trace.session?.source],
    [m['dashboard.traces.session_id'](), trace.session?.id],
    [m['dashboard.traces.session_resolved_by'](), trace.sessionResolvedBy],
    [m['dashboard.traces.protocol'](), <ProtocolLabel key="protocol" protocol={trace.inboundProtocol} />],
    [m['dashboard.traces.requested_model'](), trace.requestedModelId],
    [m['dashboard.traces.final_provider'](), trace.finalProviderId],
    [m['dashboard.traces.final_model'](), trace.finalModelId],
    [m['dashboard.traces.final_http_status'](), trace.finalHttpStatus],
    [m['dashboard.traces.error_type'](), trace.errorType],
    [m['dashboard.traces.error_code'](), trace.errorCode],
    [m['dashboard.traces.started_at'](), new Date(trace.startedAt).toLocaleString()],
    [m['dashboard.traces.ended_at'](), trace.endedAt === null ? undefined : new Date(trace.endedAt).toLocaleString()],
    [m['dashboard.traces.duration'](), formatTraceDuration(trace.durationMs)],
  ];
  const totalTokens = displayTotalTokens(trace.usage);
  const usageRows: readonly (readonly [string, ReactNode])[] = [
    [m['dashboard.traces.usage_provider'](), trace.usage?.providerId],
    [m['dashboard.traces.usage_model'](), trace.usage?.modelId],
    [m['dashboard.traces.price_model_id'](), trace.usage?.priceModelId],
    [m['dashboard.traces.input_tokens'](), trace.usage?.inputTokens],
    [m['dashboard.traces.output_tokens'](), trace.usage?.outputTokens],
    [
      m['dashboard.traces.tokens'](),
      totalTokens === undefined ? undefined : <TokenCount key="total" value={totalTokens} />,
    ],
    [m['dashboard.traces.cache_read_tokens'](), trace.usage?.cacheReadTokens],
    [m['dashboard.traces.cache_write_tokens'](), trace.usage?.cacheWriteTokens],
    [m['dashboard.traces.reasoning_tokens'](), trace.usage?.reasoningTokens],
    [m['dashboard.traces.cost'](), formatTraceCost(trace.usage?.estimatedCostUsd)],
  ];

  return (
    <PageContainer title={m['dashboard.traces.detail_title']()} subtitle={trace.traceId} extra={refresh}>
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          {[
            [m['dashboard.traces.summary'](), summaryRows],
            [m['dashboard.traces.usage'](), usageRows],
          ].map(([title, rows]) => (
            <Card key={title as string}>
              <CardHeader>
                <CardTitle>{title as string}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                  {(rows as typeof summaryRows).map(([label, value]) => (
                    <div className="contents" key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="min-w-0 text-right wrap-break-word">{value ?? missing}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{m['dashboard.traces.spans']()}</CardTitle>
          </CardHeader>
          <CardContent>
            <TraceSpansTable spans={spans} />
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
};

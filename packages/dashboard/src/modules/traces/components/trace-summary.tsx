import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSummary } from '@aio-proxy/types';
import type { ReactNode } from 'react';

import { ProtocolLabel } from '@/components/protocol-label';
import { TokenCount } from '@/components/token-count';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { displayTotalTokens, formatTraceCost, formatTraceDuration } from '../trace-formatters';
import { renderTraceStatus } from './trace-spans-table';

interface TraceSummaryProps {
  readonly trace: DashboardTraceSummary;
  readonly onSessionSelect: (session: { readonly source: string; readonly id: string }) => void;
}

export const TraceSummary: React.FC<TraceSummaryProps> = ({ trace, onSessionSelect }) => {
  const missing = m['dashboard.traces.not_available']();
  const summaryRows: readonly (readonly [string, ReactNode])[] = [
    [m['dashboard.traces.trace_id'](), trace.traceId],
    [m['dashboard.traces.root_span_id'](), trace.rootSpanId],
    [m['dashboard.traces.request_id'](), trace.requestId],
    [m['dashboard.traces.status'](), renderTraceStatus(trace)],
    [
      m['dashboard.traces.session'](),
      trace.session === undefined ? undefined : (
        <Button
          key="session"
          type="button"
          variant="link"
          className="h-auto max-w-full justify-end px-0 py-0 text-right whitespace-normal"
          onClick={() => onSessionSelect(trace.session!)}
        >
          <span>
            {trace.session.source}
            <span className="block text-xs text-muted-foreground">{trace.session.id}</span>
          </span>
        </Button>
      ),
    ],
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
    <div className="grid gap-4 xl:grid-cols-2" data-testid="trace-summary">
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
  );
};

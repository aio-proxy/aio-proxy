import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import type { ReactNode } from 'react';

import { ProtocolLabel } from '@/components/protocol-label';
import { TokenCount } from '@/components/token-count';

import { TRACE_PLACEHOLDER } from '../trace-display-constants';
import {
  displayTotalTokens,
  formatTraceCost,
  formatTraceDuration,
  formatTraceResultDetails,
} from '../trace-formatters';
import { TraceStatus } from './trace-status';

interface TraceSummaryProps {
  readonly trace: DashboardTraceSummary;
  readonly onSessionSelect: (session: { readonly source: string; readonly id: string }) => void;
}

export const TraceSummary: React.FC<TraceSummaryProps> = ({ trace, onSessionSelect }) => {
  const missing = TRACE_PLACEHOLDER;
  const sessionValue =
    trace.session === undefined ? undefined : (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="link"
              className="h-auto max-w-full justify-end px-0 py-0 text-right whitespace-normal"
              onClick={() => onSessionSelect(trace.session!)}
            />
          }
        >
          {trace.session.id}
        </TooltipTrigger>
        <TooltipContent>{m['dashboard.traces.session_source_value']({ source: trace.session.source })}</TooltipContent>
      </Tooltip>
    );
  const displayedModel = trace.requestedModelId ?? trace.finalModelId;
  const upstreamModel =
    trace.requestedModelId !== undefined &&
    trace.finalModelId !== undefined &&
    trace.requestedModelId !== trace.finalModelId
      ? trace.finalModelId
      : undefined;
  const modelValue =
    displayedModel === undefined || upstreamModel === undefined ? (
      displayedModel
    ) : (
      <Tooltip>
        <TooltipTrigger
          render={<span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-4" />}
        >
          {displayedModel}
        </TooltipTrigger>
        <TooltipContent>{m['dashboard.traces.upstream_model_value']({ model: upstreamModel })}</TooltipContent>
      </Tooltip>
    );
  const resultDetails = formatTraceResultDetails({
    httpStatus: trace.finalHttpStatus,
    errorType: trace.errorType,
    errorCode: trace.errorCode,
  });
  const summaryRows: readonly (readonly [string, ReactNode])[] = [
    [m['dashboard.traces.trace_id'](), trace.traceId],
    [m['dashboard.traces.root_span_id'](), trace.rootSpanId],
    [m['dashboard.traces.request_id'](), trace.requestId],
    [m['dashboard.traces.status'](), <TraceStatus key="status" item={trace} className="justify-end" />],
    [m['dashboard.traces.session'](), sessionValue],
    [m['dashboard.traces.protocol'](), <ProtocolLabel key="protocol" protocol={trace.inboundProtocol} />],
    [m['dashboard.traces.model'](), modelValue],
    [m['dashboard.traces.final_provider'](), trace.finalProviderId],
    [m['dashboard.traces.result_details'](), resultDetails],
    [m['dashboard.traces.started_at'](), new Date(trace.startedAt).toLocaleString()],
    [m['dashboard.traces.ended_at'](), trace.endedAt === null ? undefined : new Date(trace.endedAt).toLocaleString()],
    [m['dashboard.traces.duration'](), formatTraceDuration(trace.durationMs)],
  ];
  const totalTokens = displayTotalTokens(trace.usage);
  const usageRows: readonly (readonly [string, ReactNode])[] = [
    [m['dashboard.traces.usage_provider'](), trace.usage?.providerId],
    [m['dashboard.traces.usage_model'](), trace.usage?.modelId],
    [m['dashboard.traces.price_model_id'](), trace.usage?.priceModelId],
    [m['dashboard.traces.input_tokens'](), <TokenCount key="input" value={trace.usage?.inputTokens} />],
    [m['dashboard.traces.output_tokens'](), <TokenCount key="output" value={trace.usage?.outputTokens} />],
    [m['dashboard.traces.tokens'](), <TokenCount key="total" value={totalTokens} />],
    [m['dashboard.traces.cache_read_tokens'](), <TokenCount key="cache-read" value={trace.usage?.cacheReadTokens} />],
    [
      m['dashboard.traces.cache_write_tokens'](),
      <TokenCount key="cache-write" value={trace.usage?.cacheWriteTokens} />,
    ],
    [m['dashboard.traces.reasoning_tokens'](), <TokenCount key="reasoning" value={trace.usage?.reasoningTokens} />],
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

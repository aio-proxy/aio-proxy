import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import type { ReactNode } from 'react';

import { ProtocolLabel } from '@/components/protocol-label';
import { TokenCount } from '@/components/token-count';
import { formatDuration } from '@/lib/format-duration';

import { TRACE_PLACEHOLDER } from '../lib/trace-display-constants';
import { displayTotalTokens, formatTraceCost, formatTraceResultDetails } from '../lib/trace-formatters';
import { TraceStatus } from './trace-status';

interface TraceSummaryProps {
  readonly trace: DashboardTraceSummary;
  readonly onSessionSelect: (session: { readonly source: string; readonly id: string }) => void;
}

export const TraceSummary: React.FC<TraceSummaryProps> = ({ trace, onSessionSelect }) => {
  const sessionValue =
    trace.session === undefined ? undefined : (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="link"
              className="h-auto max-w-full justify-start px-0 py-0 text-left whitespace-normal"
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
  const sections: readonly (readonly [string, readonly (readonly [string, ReactNode])[]])[] = [
    [
      m['dashboard.traces.summary'](),
      [
        [m['dashboard.traces.trace_id'](), trace.traceId],
        [m['dashboard.traces.root_span_id'](), trace.rootSpanId],
        [m['dashboard.traces.request_id'](), trace.requestId],
        [m['dashboard.traces.session_id'](), sessionValue],
        [m['dashboard.traces.started_at'](), new Date(trace.startedAt).toLocaleString()],
        [
          m['dashboard.traces.ended_at'](),
          trace.endedAt === null ? undefined : new Date(trace.endedAt).toLocaleString(),
        ],
        [m['dashboard.traces.duration'](), formatDuration(trace.durationMs)],
      ],
    ],
    [
      m['dashboard.traces.routing'](),
      [
        [m['dashboard.traces.protocol'](), <ProtocolLabel key="protocol" protocol={trace.inboundProtocol} />],
        [m['dashboard.traces.model'](), modelValue],
        [m['dashboard.traces.final_provider'](), trace.finalProviderId],
      ],
    ],
    [
      m['dashboard.traces.result_details'](),
      [
        [m['dashboard.traces.status'](), <TraceStatus key="status" item={trace} />],
        [
          m['dashboard.traces.result_details'](),
          formatTraceResultDetails({
            httpStatus: trace.finalHttpStatus,
            errorType: trace.errorType,
            errorCode: trace.errorCode,
          }),
        ],
      ],
    ],
    [
      m['dashboard.traces.usage'](),
      [
        [m['dashboard.traces.usage_provider'](), trace.usage?.providerId],
        [m['dashboard.traces.usage_model'](), trace.usage?.modelId],
        [m['dashboard.traces.price_model_id'](), trace.usage?.priceModelId],
        [m['dashboard.traces.input_tokens'](), <TokenCount key="input" value={trace.usage?.inputTokens} />],
        [m['dashboard.traces.output_tokens'](), <TokenCount key="output" value={trace.usage?.outputTokens} />],
        [m['dashboard.traces.tokens'](), <TokenCount key="total" value={displayTotalTokens(trace.usage)} />],
        [
          m['dashboard.traces.cache_read_tokens'](),
          <TokenCount key="cache-read" value={trace.usage?.cacheReadTokens} />,
        ],
        [
          m['dashboard.traces.cache_write_tokens'](),
          <TokenCount key="cache-write" value={trace.usage?.cacheWriteTokens} />,
        ],
        [m['dashboard.traces.reasoning_tokens'](), <TokenCount key="reasoning" value={trace.usage?.reasoningTokens} />],
        [m['dashboard.traces.cost'](), formatTraceCost(trace.usage?.estimatedCostUsd)],
      ],
    ],
  ];

  return (
    <div className="space-y-6" data-testid="trace-summary">
      {sections.map(([title, rows]) => (
        <section className="space-y-3" key={title}>
          <h2 className="font-heading text-sm font-semibold">{title}</h2>
          <dl className="space-y-2 text-sm">
            {rows.map(([label, value]) => (
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-3" key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 text-left wrap-break-word">{value ?? TRACE_PLACEHOLDER}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
};

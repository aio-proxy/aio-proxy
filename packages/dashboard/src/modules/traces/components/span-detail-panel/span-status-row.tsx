import type { DashboardTraceSpan } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';

import type { SpanMetrics } from '../../lib/span-metrics';
import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';
import { TraceStatus } from '../trace-status';

interface SpanStatusRowProps {
  readonly span: DashboardTraceSpan;
  readonly metrics: SpanMetrics;
}

export const SpanStatusRow: React.FC<SpanStatusRowProps> = ({ span, metrics }) => {
  // Provider ID and model ID are identifiers: never translated, joined only when both exist.
  const identity = [metrics.providerId, metrics.modelId].filter((value) => value !== undefined).join(' · ');
  const failed = span.otelStatusCode === 'ERROR' || (metrics.httpStatus !== undefined && metrics.httpStatus >= 400);

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2" data-testid="span-status-row">
      {metrics.httpStatus === undefined ? (
        <TraceStatus item={span} />
      ) : (
        <Badge variant={failed ? 'destructive' : 'secondary'} className="font-mono tabular-nums">
          {metrics.httpStatus}
        </Badge>
      )}
      <span className="min-w-0 text-xs wrap-break-word text-muted-foreground">
        {identity.length === 0 ? TRACE_PLACEHOLDER : identity}
      </span>
    </div>
  );
};

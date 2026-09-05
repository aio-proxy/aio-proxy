import { m } from '@aio-proxy/i18n';
import { Zap } from 'lucide-react';

import { formatDuration } from '@/lib/format-duration';

import { TRACE_PLACEHOLDER, TRACE_TTFT_LABEL } from '../../lib/trace-display-constants';
import { firstResponseTimeGrade, latencyDotClassName, responseTimeGrade } from '../../lib/trace-latency-grade';

interface TraceLatencyCellProps {
  readonly durationMs: number;
  readonly stream?: boolean | undefined;
  readonly ttftMs?: number | undefined;
  readonly fast?: boolean | undefined;
  readonly outputTokens?: number | undefined;
}

export const TraceLatencyCell: React.FC<TraceLatencyCellProps> = ({
  durationMs,
  stream = false,
  ttftMs,
  fast = false,
  outputTokens,
}) => (
  <div className="grid min-w-32 grid-cols-[0.375rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
    <span
      aria-hidden="true"
      className={latencyDotClassName(responseTimeGrade(durationMs, outputTokens ?? 0))}
      data-latency-dot
    />
    <span className="inline-flex items-center gap-1.5">
      {formatDuration(durationMs)}
      {fast ? (
        <Zap aria-label={m['dashboard.traces.fast_latency']()} className="size-3 text-primary" data-fast-marker />
      ) : null}
    </span>
    {stream ? (
      <>
        {ttftMs === undefined ? (
          <span aria-hidden="true" />
        ) : (
          <span aria-hidden="true" className={latencyDotClassName(firstResponseTimeGrade(ttftMs))} data-latency-dot />
        )}
        <span className="text-xs text-muted-foreground">
          {TRACE_TTFT_LABEL} {ttftMs === undefined ? TRACE_PLACEHOLDER : formatDuration(ttftMs)}
        </span>
      </>
    ) : null}
  </div>
);

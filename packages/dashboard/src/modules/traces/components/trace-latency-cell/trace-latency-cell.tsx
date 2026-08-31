import { m } from '@aio-proxy/i18n';
import { cn } from '@aio-proxy/ui/lib/utils';
import { Zap } from 'lucide-react';

import { TRACE_PLACEHOLDER, TRACE_TTFT_LABEL } from '../../lib/trace-display-constants';
import { formatTraceDuration } from '../../lib/trace-formatters';

interface TraceLatencyCellProps {
  readonly durationMs: number;
  readonly stream?: boolean | undefined;
  readonly ttftMs?: number | undefined;
  readonly fast?: boolean | undefined;
}

const dotClassName = (milliseconds: number) => {
  if (milliseconds < 1_000) return cn('size-1.5 rounded-full', 'bg-primary');
  return cn('size-1.5 rounded-full', milliseconds < 3_000 ? 'bg-muted-foreground' : 'bg-destructive');
};

export const TraceLatencyCell: React.FC<TraceLatencyCellProps> = ({
  durationMs,
  stream = false,
  ttftMs,
  fast = false,
}) => (
  <div className="grid min-w-32 grid-cols-[0.375rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
    <span aria-hidden="true" className={dotClassName(durationMs)} data-latency-dot />
    <span className="inline-flex items-center gap-1.5">
      {formatTraceDuration(durationMs)}
      {fast ? (
        <Zap aria-label={m['dashboard.traces.fast_latency']()} className="size-3 text-primary" data-fast-marker />
      ) : null}
    </span>
    {stream ? (
      <>
        {ttftMs === undefined ? (
          <span aria-hidden="true" />
        ) : (
          <span aria-hidden="true" className={dotClassName(ttftMs)} data-latency-dot />
        )}
        <span className="text-xs text-muted-foreground">
          {TRACE_TTFT_LABEL} {ttftMs === undefined ? TRACE_PLACEHOLDER : formatTraceDuration(ttftMs)}
        </span>
      </>
    ) : null}
  </div>
);

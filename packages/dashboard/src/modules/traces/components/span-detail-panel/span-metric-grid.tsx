import { getLocale, m } from '@aio-proxy/i18n';

import { formatDuration } from '@/lib/format-duration';

import type { SpanMetrics } from '../../lib/span-metrics';
import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';

interface SpanMetricGridProps {
  readonly metrics: SpanMetrics;
}

export const SpanMetricGrid: React.FC<SpanMetricGridProps> = ({ metrics }) => {
  const formatCount = new Intl.NumberFormat(getLocale());
  const duration = (value: number | undefined) => (value === undefined ? TRACE_PLACEHOLDER : formatDuration(value));
  const count = (value: number | undefined) => (value === undefined ? TRACE_PLACEHOLDER : formatCount.format(value));

  // Always six cells: a stable position beats saving space when a value is missing.
  const cells = [
    [m['dashboard.traces.span_metric_total'](), duration(metrics.durationMs)],
    [m['dashboard.traces.span_metric_ttft'](), duration(metrics.ttftMs)],
    [m['dashboard.traces.span_metric_upstream'](), duration(metrics.upstreamMs)],
    [m['dashboard.traces.span_metric_input_tokens'](), count(metrics.inputTokens)],
    [m['dashboard.traces.span_metric_output_tokens'](), count(metrics.outputTokens)],
    [m['dashboard.traces.span_metric_attempts'](), count(metrics.attemptCount)],
  ] as const;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3" data-testid="span-metric-grid">
      {cells.map(([label, value]) => (
        <div className="min-w-0" key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-mono wrap-break-word tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
};

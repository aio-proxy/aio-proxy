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
    [m['dashboard.traces.input_tokens'](), count(metrics.inputTokens)],
    [m['dashboard.traces.output_tokens'](), count(metrics.outputTokens)],
    [m['dashboard.traces.span_metric_attempts'](), count(metrics.attemptCount)],
  ] as const;

  // 发丝线网格：容器铺 border 色、格子铺 card 色，1px 的 gap 就是分隔线，
  // 六个格子之间不用各画一条 border 再去掉重叠的那条。
  return (
    <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-border" data-testid="span-metric-grid">
      {cells.map(([label, value]) => (
        <div className="min-w-0 bg-card px-3 py-2.5" key={label}>
          <dt className="mb-0.5 text-[11px] text-muted-foreground">{label}</dt>
          <dd className="font-mono text-sm wrap-break-word tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
};

import { m } from '@aio-proxy/i18n';
import type { DashboardTracePercentile } from '@aio-proxy/types';

import { formatDuration } from '@/lib/format-duration';

interface TracePercentileBarProps {
  readonly comparison: DashboardTracePercentile | null | undefined;
}

export const TracePercentileBar: React.FC<TracePercentileBarProps> = ({ comparison }) => {
  // 样本不足（null）和还没拿到（undefined）都不画：一根空条会被当成「这次特别快」。
  if (comparison === null || comparison === undefined) return null;

  const { minMs, maxMs } = comparison;
  const span = maxMs - minMs;
  // 全窗口一样快时分布没有宽度，所有标记压到左端，而不是除出 NaN。
  const offset = (value: number) => (span <= 0 ? 0 : Math.min(1, Math.max(0, (value - minMs) / span)) * 100);
  const ticks = [
    ['p50', comparison.p50Ms],
    ['p95', comparison.p95Ms],
  ] as const;

  return (
    <div className="space-y-1" data-testid="trace-percentile-bar">
      <p className="text-xs text-muted-foreground">
        {m['dashboard.traces.percentile_caption']({
          count: comparison.sampleCount,
          model: comparison.modelId,
          percentile: comparison.percentile,
        })}
      </p>
      <div className="relative h-2 rounded-full bg-muted">
        {ticks.map(([label, value]) => (
          <span
            aria-hidden
            className="absolute inset-y-0 w-px bg-border"
            key={label}
            style={{ left: `${offset(value)}%` }}
          />
        ))}
        <span
          aria-hidden
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
          data-testid="trace-percentile-marker"
          style={{ left: `${offset(comparison.durationMs)}%` }}
        />
      </div>
      <div className="relative flex justify-between text-xs text-muted-foreground">
        <span>{formatDuration(minMs)}</span>
        {ticks.map(([label, value]) => (
          <span className="absolute -translate-x-1/2" key={label} style={{ left: `${offset(value)}%` }}>
            {label}
          </span>
        ))}
        <span>{formatDuration(maxMs)}</span>
      </div>
    </div>
  );
};

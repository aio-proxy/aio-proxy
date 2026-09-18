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
      <div className="relative mt-7 h-1.5 rounded-[3px] bg-muted">
        {/* 渐变只是「越靠右越慢」的视觉提示，本身不携带数据，所以整条铺满、压低透明度。 */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-[3px] bg-gradient-to-r from-chart-success to-chart-error opacity-35"
        />
        {ticks.map(([label, value]) => (
          <span
            aria-hidden
            className="absolute -top-[3px] h-3 w-0.5 -translate-x-1/2 rounded-[1px] bg-muted-foreground/55"
            key={label}
            style={{ left: `${offset(value)}%` }}
          />
        ))}
        <span
          aria-hidden
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card"
          data-testid="trace-percentile-marker"
          style={{ left: `${offset(comparison.durationMs)}%` }}
        >
          <span className="absolute bottom-3.5 left-1/2 -translate-x-1/2 font-mono text-[11px] whitespace-nowrap text-foreground">
            {formatDuration(comparison.durationMs)}
          </span>
        </span>
      </div>
      <div className="relative flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{formatDuration(minMs)}</span>
        {ticks.map(([label, value]) => (
          // 条上的刻度，读屏没必要念：上面那行说明已经把名次说清楚了。
          <span aria-hidden className="absolute -translate-x-1/2" key={label} style={{ left: `${offset(value)}%` }}>
            {label}
          </span>
        ))}
        <span>{formatDuration(maxMs)}</span>
      </div>
    </div>
  );
};

import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';
import { CircleAlert } from 'lucide-react';

import { formatDuration } from '@/lib/format-duration';

import { isFailedSpan } from '../../lib/trace-failure';
import type { layoutTraceSpans } from '../../lib/trace-layout';

type TraceWaterfallRowItem = ReturnType<typeof layoutTraceSpans>[number];

// 表头（刻度尺）和数据行必须共用同一套列宽，否则刻度和柱子会错开一个名称列。
export const WATERFALL_GRID =
  'grid grid-cols-[minmax(7rem,12.5rem)_minmax(0,1fr)_3.875rem] items-center gap-2.5 px-1.5';

interface TraceWaterfallRowProps {
  readonly row: TraceWaterfallRowItem;
  readonly selectedSpanId: string | undefined;
  readonly onSelect: (spanId: string) => void;
}

export const TraceWaterfallRow: React.FC<TraceWaterfallRowProps> = ({ row, selectedSpanId, onSelect }) => {
  const failed = isFailedSpan(row);
  // 取消从失败判定里摘出去之后，它会落到成功那一格 —— 客户端主动中止的操作画成绿柱子。
  // 中性的两态（还在跑 / 已取消）共用一个弱化色，和跳选择器的圆点同一套判据。
  let barClassName = 'bg-chart-success';
  if (row.endedAt === null || row.terminationReason === 'cancelled') barClassName = 'bg-muted-foreground/40';
  if (failed) barClassName = 'bg-chart-error';
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(WATERFALL_GRID, 'h-auto w-full py-1 text-left', row.spanId === selectedSpanId && 'bg-primary/10')}
      aria-label={m['dashboard.traces.select_span']({ name: row.name, spanId: row.spanId })}
      aria-pressed={row.spanId === selectedSpanId}
      data-testid="trace-span"
      onClick={() => onSelect(row.spanId)}
    >
      <span className="flex min-w-0 items-center gap-1" style={{ paddingInlineStart: `${row.depth * 14}px` }}>
        {/* 失败不能只靠柱子的颜色：色觉障碍和打印都丢信息，所以图标 + 读屏文案各补一份。 */}
        {failed && <CircleAlert className="size-3.5 shrink-0 text-chart-error" aria-hidden="true" />}
        <span className="truncate">{row.name}</span>
        {failed && <span className="sr-only">{m['dashboard.traces.failure']()}</span>}
      </span>
      <span className="relative h-2.5">
        <span
          className={cn('absolute inset-y-0 rounded-[3px]', barClassName)}
          style={{ left: `${row.offsetRatio * 100}%`, width: `${row.widthRatio * 100}%` }}
        />
        {row.ttftRatio === undefined ? null : (
          /* 首字刻度。装饰性重复：同一个数在详情面板的 TTFT 格子里有文字版，
             所以这里 aria-hidden，不往行的读屏文案里再塞一个数。
             比柱子高一点才看得见：压在柱子里面会被圆角和填充色吃掉。 */
          <span
            className="absolute inset-y-[-3px] w-px bg-foreground/70"
            style={{ left: `${row.ttftRatio * 100}%` }}
            data-testid="waterfall-ttft-tick"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
        {formatDuration(row.durationMs)}
      </span>
    </Button>
  );
};

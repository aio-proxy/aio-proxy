import { cn } from '@aio-proxy/ui/lib/utils';

import { formatDuration } from '@/lib/format-duration';

import { createWaterfallTicks } from '../../lib/trace-waterfall-ticks';

interface WaterfallRulerProps {
  readonly totalDurationMs: number;
  readonly className?: string;
}

// aria-hidden 是刻意的：刻度是给眼睛看的装饰，每行 Button 的 aria-label 已经带了 span 名称，
// 总时长在右侧耗时列里也念得到。
export const WaterfallRuler: React.FC<WaterfallRulerProps> = ({ totalDurationMs, className }) => (
  <div className={cn('relative h-4 border-b', className)} data-testid="waterfall-ruler" aria-hidden="true">
    {createWaterfallTicks(totalDurationMs).map((tick) => (
      <span
        key={tick.ratio}
        // 最后一格钉在右边、刻度线画在右侧，不然 100% 的标签会整个溢出容器。
        // 边框只能用 Tailwind 的 border-l / border-r：内联 `borderRight: '1px solid'`
        // 会取 currentColor，跟其他几格的 --border 不是一个颜色。
        className={cn(
          'absolute bottom-0 flex h-full items-end font-mono text-[10px] text-muted-foreground tabular-nums',
          tick.ratio === 1 ? 'right-0 border-r pr-1' : 'border-l pl-1',
        )}
        style={tick.ratio === 1 ? undefined : { left: `${tick.ratio * 100}%` }}
      >
        {formatDuration(tick.durationMs)}
      </span>
    ))}
  </div>
);

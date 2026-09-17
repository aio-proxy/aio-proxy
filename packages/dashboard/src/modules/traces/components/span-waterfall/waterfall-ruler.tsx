import { formatDuration } from '@/lib/format-duration';

import { createWaterfallTicks } from '../../lib/trace-waterfall-ticks';

interface WaterfallRulerProps {
  readonly totalDurationMs: number;
}

// aria-hidden 是刻意的：刻度是给眼睛看的装饰，每行 Button 的 aria-label 已经带了 span 名称，
// 总时长在右侧耗时列里也念得到。
export const WaterfallRuler: React.FC<WaterfallRulerProps> = ({ totalDurationMs }) => (
  <div className="relative h-4 border-b" data-testid="waterfall-ruler" aria-hidden="true">
    {createWaterfallTicks(totalDurationMs).map((tick) => (
      <span
        key={tick.ratio}
        className="absolute bottom-0 flex h-full items-end border-l pl-1 font-mono text-[10px] text-muted-foreground tabular-nums"
        style={
          tick.ratio === 1
            ? { right: 0, borderLeft: 'none', borderRight: '1px solid', paddingLeft: 0, paddingRight: '0.25rem' }
            : { left: `${tick.ratio * 100}%` }
        }
      >
        {formatDuration(tick.durationMs)}
      </span>
    ))}
  </div>
);

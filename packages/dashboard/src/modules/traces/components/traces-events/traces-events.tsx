import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useAtom } from 'jotai';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId } from 'react';

import { useTraceSummaryQuery } from '../../hooks/use-trace-summary-query';
import { type TraceSearch, withTraceFilters } from '../../lib/trace-search';
import { tracesEventsCollapsedAtom } from '../../stores/traces-events-collapsed';
import { TracesEventsChart } from '../traces-events-chart';

interface TracesEventsProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly onChange: (search: TraceSearch) => void;
}

export const TracesEvents: React.FC<TracesEventsProps> = ({ search, autoRefresh, onChange }) => {
  const bodyId = useId();
  const [collapsed, setCollapsed] = useAtom(tracesEventsCollapsedAtom);
  const query = useTraceSummaryQuery(search, autoRefresh);
  const formatCount = new Intl.NumberFormat(getLocale());
  const totals = query.data?.totals ?? { success: 0, error: 0 };
  const chips = [
    { code: 'OK', label: m['dashboard.traces.success'](), count: totals.success, dot: 'bg-chart-success' },
    { code: 'ERROR', label: m['dashboard.traces.failure'](), count: totals.error, dot: 'bg-chart-error' },
  ] as const;
  // 只剩一个桶就没法再收窄了（1m 粒度下每次缩放的结果都是这个状态），
  // 那就别再摆出可点的样子：提示语收起来，柱子也不显示手型。
  const canZoom = (query.data?.buckets.length ?? 0) > 1;
  // 只有摘要挂了、列表还好的时候：TanStack Query 留着上一次的 data，图会继续画旧数
  // 据。不吭声的话那张图看起来就是当前的，所以在提示位上说明这是旧数据 —— 图还有参
  // 考价值，不值得把整块换掉，也不能用「加载不出来」的文案去盖一张正画着数字的图。
  const staleError = query.isError && query.data !== undefined;

  const selectBucket = (at: string) => {
    const [first, second] = query.data?.buckets ?? [];
    // 桶宽从相邻两个桶的间隔推出来，不在前端再抄一份粒度表。只有一个桶时，
    // 收窄的结果就是当前范围本身，直接不动。
    if (first === undefined || second === undefined) return;
    const startMs = Date.parse(at);
    const bucketMs = Date.parse(second.at) - Date.parse(first.at);
    onChange(
      withTraceFilters(search, {
        startedAfter: new Date(startMs).toISOString(),
        // 服务端的 startedBefore 是闭区间，减 1ms 免得把下一个桶的第一条也捞进来。
        // 再跟当前范围的右端取小：桶是从范围起点开始排的，范围不是桶宽的整数倍时
        // 服务端会把最后一个桶截短，这里不夹住就会选到图上根本没画的那段时间。
        startedBefore: new Date(Math.min(startMs + bucketMs - 1, Date.parse(search.startedBefore))).toISOString(),
      }),
    );
  };

  return (
    <section className="border-b" aria-label={m['dashboard.traces.events']()}>
      <header className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2">
        {chips.map((chip) => {
          const pressed = search.otelStatusCode === chip.code;
          // 抽屉里还能筛 UNSET（还在跑），那时两个 chip 都不是按下态，也都该淡出。
          const filteredOut = search.otelStatusCode !== undefined && !pressed;
          return (
            <button
              key={chip.code}
              type="button"
              aria-pressed={pressed}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-opacity',
                pressed && 'border-ring',
                filteredOut && 'opacity-50',
              )}
              onClick={() => onChange(withTraceFilters(search, { otelStatusCode: pressed ? undefined : chip.code }))}
            >
              <span className={cn('size-2 rounded-full', chip.dot)} />
              <span className="font-medium tabular-nums">{formatCount.format(chip.count)}</span>
              <span className="text-muted-foreground">{chip.label}</span>
            </button>
          );
        })}
        {/* span 常在：ml-auto 靠它把折叠按钮顶到右边，提示语只是它的内容。
            提示语在窄屏可以省，旧数据的警告不行。 */}
        <span className={cn('ml-auto text-xs text-muted-foreground', !staleError && 'max-sm:hidden')}>
          {staleError ? m['dashboard.traces.events_stale']() : canZoom && m['dashboard.traces.events_hint']()}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          title={collapsed ? m['dashboard.traces.events_expand']() : m['dashboard.traces.events_collapse']()}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </header>
      {!collapsed && (
        <div id={bodyId} className="px-3 pb-3">
          {query.isLoading && <Skeleton className="h-40 w-full" />}
          {/* 从没成功过才铺整块错误：有旧数据时错误只在表头轻提示一句，图留着。 */}
          {query.isError && query.data === undefined && (
            <p className="text-xs text-muted-foreground">{m['dashboard.traces.error_title']()}</p>
          )}
          {query.data && (
            <TracesEventsChart
              buckets={query.data.buckets}
              bucket={query.data.bucket}
              canZoom={canZoom}
              onBucketSelect={selectBucket}
            />
          )}
        </div>
      )}
    </section>
  );
};

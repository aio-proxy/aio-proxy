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
        // 服务端的 startedBefore 是闭区间，减 1ms 免得把下一个桶的第一条也捞进来
        startedBefore: new Date(startMs + bucketMs - 1).toISOString(),
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
        <span className="ml-auto text-xs text-muted-foreground max-sm:hidden">
          {m['dashboard.traces.events_hint']()}
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
          {query.isError && <p className="text-xs text-muted-foreground">{m['dashboard.traces.error_title']()}</p>}
          {query.data && (
            <TracesEventsChart buckets={query.data.buckets} bucket={query.data.bucket} onBucketSelect={selectBucket} />
          )}
        </div>
      )}
    </section>
  );
};

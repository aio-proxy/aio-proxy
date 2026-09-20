import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';

import type { TraceHopChip, TraceHopStatus } from '../../lib/trace-hops';

interface TraceHopSelectorProps {
  readonly hops: readonly TraceHopChip[];
  readonly selectedHopId: string;
  readonly onSelect: (hopId: string) => void;
}

// 圆点的颜色和读屏的词都按状态走。中性的两态（还在跑 / 已取消）不能借用成功色 —— 那正是
// 「不是失败就算成功」留下的谎。
const dotClass: Record<TraceHopStatus, string> = {
  running: 'bg-muted-foreground',
  cancelled: 'bg-muted-foreground',
  failure: 'bg-chart-error',
  success: 'bg-chart-success',
};

// 穷尽的 switch 而不是查表：加一个状态时这里编译不过，而查表只会在运行时给个 undefined。
const statusLabel = (status: TraceHopStatus): string => {
  switch (status) {
    case 'running':
      return m['dashboard.traces.running']();
    case 'cancelled':
      return m['dashboard.traces.cancelled']();
    case 'failure':
      return m['dashboard.traces.failure']();
    case 'success':
      return m['dashboard.traces.success']();
  }
};

export const TraceHopSelector: React.FC<TraceHopSelectorProps> = ({ hops, selectedHopId, onSelect }) => (
  <div className="flex flex-wrap gap-2" role="group" aria-label={m['dashboard.traces.hops_label']()}>
    {hops.map((hop) => {
      const selected = hop.id === selectedHopId;
      return (
        <Button
          key={hop.id}
          size="sm"
          variant={selected ? 'secondary' : 'outline'}
          aria-pressed={selected}
          onClick={() => onSelect(hop.id)}
        >
          <span className={cn('size-1.5 rounded-full', dotClass[hop.status])} aria-hidden="true" />
          {hop.kind === 'inbound' && m['dashboard.traces.hop_inbound']({ label: hop.label })}
          {/* attempt span 没写 index 时不编一个序号：两颗 chip 都叫「尝试 1」比没有序号更糟。 */}
          {hop.kind === 'attempt' &&
            (hop.attemptIndex === undefined
              ? hop.label
              : m['dashboard.traces.hop_attempt']({ index: hop.attemptIndex + 1, label: hop.label }))}
          {/* 圆点是 aria-hidden 的，成败就只剩颜色一个载体，而「哪一跳挂了」正是这排 chip 唯一
              要传达的信息。补一个只给读屏的词，用和 TraceStatus 同一套说法。 */}
          <span className="sr-only">{statusLabel(hop.status)}</span>
        </Button>
      );
    })}
  </div>
);

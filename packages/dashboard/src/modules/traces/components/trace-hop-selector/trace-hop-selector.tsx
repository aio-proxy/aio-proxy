import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';

import type { TraceHopChip } from '../../lib/trace-hops';

interface TraceHopSelectorProps {
  readonly hops: readonly TraceHopChip[];
  readonly selectedHopId: string;
  readonly onSelect: (hopId: string) => void;
}

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
          <span
            className={cn('size-1.5 rounded-full', hop.failed ? 'bg-chart-error' : 'bg-chart-success')}
            aria-hidden="true"
          />
          {hop.kind === 'inbound' && m['dashboard.traces.hop_inbound']({ label: hop.label })}
          {/* attempt span 没写 index 时不编一个序号：两颗 chip 都叫「尝试 1」比没有序号更糟。 */}
          {hop.kind === 'attempt' &&
            (hop.attemptIndex === undefined
              ? hop.label
              : m['dashboard.traces.hop_attempt']({ index: hop.attemptIndex + 1, label: hop.label }))}
        </Button>
      );
    })}
  </div>
);

import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

import { formatTraceDuration } from '../../lib/trace-formatters';
import type { layoutTraceSpans } from '../../lib/trace-layout';
import { TraceStatus } from '../trace-status';

type TraceWaterfallRowItem = ReturnType<typeof layoutTraceSpans>[number];

interface TraceWaterfallRowProps {
  readonly row: TraceWaterfallRowItem;
  readonly selectedSpanId: string | undefined;
  readonly onSelect: (spanId: string) => void;
}

export const TraceWaterfallRow: React.FC<TraceWaterfallRowProps> = ({ row, selectedSpanId, onSelect }) => {
  let barClassName = 'bg-primary';
  if (row.endedAt === null) barClassName = 'bg-secondary-foreground/50';
  if (row.otelStatusCode === 'ERROR') barClassName = 'bg-destructive';
  return (
    <Button
      type="button"
      variant={row.spanId === selectedSpanId ? 'secondary' : 'ghost'}
      className="grid h-auto w-full grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_auto_auto] items-center gap-3 px-3 py-2 text-left"
      aria-label={m['dashboard.traces.select_span']({ name: row.name, spanId: row.spanId })}
      aria-pressed={row.spanId === selectedSpanId}
      data-testid="trace-span"
      onClick={() => onSelect(row.spanId)}
    >
      <span className="min-w-0" style={{ paddingInlineStart: `${row.depth * 16}px` }}>
        <span className="block truncate font-medium">{row.name}</span>
        <span className="block text-xs text-muted-foreground">{row.kind}</span>
      </span>
      <span className="relative h-5 overflow-hidden rounded-2xl bg-muted">
        <span
          className={`absolute inset-y-1 rounded-2xl ${barClassName}`}
          style={{ left: `${row.offsetRatio * 100}%`, width: `${row.widthRatio * 100}%` }}
        />
      </span>
      <TraceStatus item={row} className="justify-end" />
      <span className="text-right font-mono text-xs tabular-nums">{formatTraceDuration(row.durationMs)}</span>
    </Button>
  );
};

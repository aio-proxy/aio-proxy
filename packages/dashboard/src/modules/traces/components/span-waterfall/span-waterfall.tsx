import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';

import { formatTraceDuration } from '../../lib/trace-formatters';
import { layoutTraceSpans } from '../../lib/trace-layout';
import { TraceStatus } from '../trace-status';

interface SpanWaterfallProps {
  readonly spans: readonly DashboardTraceSpan[];
  readonly selectedSpanId: string | undefined;
  readonly now?: Date;
  readonly onSelect: (spanId: string) => void;
}

type TraceWaterfallRowItem = ReturnType<typeof layoutTraceSpans>[number];

export const SpanWaterfall: React.FC<SpanWaterfallProps> = ({ spans, selectedSpanId, now = new Date(), onSelect }) => {
  const rows = layoutTraceSpans(spans, now);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m['dashboard.traces.spans']()}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <div className="min-w-3xl space-y-1">
          <div className="grid grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_auto_auto] items-center gap-3 px-3 text-xs font-medium text-muted-foreground">
            <span>{m['dashboard.traces.span_name']()}</span>
            <span>{m['dashboard.traces.waterfall']()}</span>
            <span>{m['dashboard.traces.status']()}</span>
            <span className="text-right">{m['dashboard.traces.duration']()}</span>
          </div>
          {rows.map((row) => (
            <TraceWaterfallRow key={row.spanId} row={row} selectedSpanId={selectedSpanId} onSelect={onSelect} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

const TraceWaterfallRow: React.FC<{
  readonly row: TraceWaterfallRowItem;
  readonly selectedSpanId: string | undefined;
  readonly onSelect: (spanId: string) => void;
}> = ({ row, selectedSpanId, onSelect }) => {
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

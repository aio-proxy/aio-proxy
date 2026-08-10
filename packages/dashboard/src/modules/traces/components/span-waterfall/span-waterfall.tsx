import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';

import { layoutTraceSpans } from '../../lib/trace-layout';
import { TraceWaterfallRow } from './trace-waterfall-row';

interface SpanWaterfallProps {
  readonly spans: readonly DashboardTraceSpan[];
  readonly selectedSpanId: string | undefined;
  readonly now?: Date;
  readonly onSelect: (spanId: string) => void;
}

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

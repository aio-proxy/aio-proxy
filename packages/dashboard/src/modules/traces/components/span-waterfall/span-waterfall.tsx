import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { layoutTraceSpans } from '../../lib/trace-layout';
import { TraceWaterfallRow } from './trace-waterfall-row';
import { WaterfallRuler } from './waterfall-ruler';

interface SpanWaterfallProps {
  readonly spans: readonly DashboardTraceSpan[];
  readonly selectedSpanId: string | undefined;
  readonly now?: Date;
  readonly onSelect: (spanId: string) => void;
}

export const SpanWaterfall: React.FC<SpanWaterfallProps> = ({ spans, selectedSpanId, now = new Date(), onSelect }) => {
  const [query, setQuery] = useState('');
  const rows = layoutTraceSpans(spans, now);
  const needle = query.trim().toLowerCase();
  const visible = needle === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(needle));
  // 刻度尺用 layout 算出的整条调用链跨度，不跟着搜索结果缩放，也不用根 span 的耗时 ——
  // 每行的 offsetRatio/widthRatio 都是相对这个跨度算的，换个基准刻度就对不上柱子了。
  const totalDurationMs = rows[0]?.scaleDurationMs ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m['dashboard.traces.spans']()}</CardTitle>
        <CardAction>
          <InputGroup className="w-full sm:w-56">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              data-testid="span-search"
              aria-label={m['dashboard.traces.span_search_placeholder']()}
              placeholder={m['dashboard.traces.span_search_placeholder']()}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <div className="min-w-3xl space-y-1">
          <div className="grid grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)_auto_auto] items-end gap-3 px-3 text-xs font-medium text-muted-foreground">
            <span>{m['dashboard.traces.span_name']()}</span>
            <WaterfallRuler totalDurationMs={totalDurationMs} />
            <span>{m['dashboard.traces.status']()}</span>
            <span className="text-right">{m['dashboard.traces.duration']()}</span>
          </div>
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {m['dashboard.traces.span_search_empty']()}
            </p>
          ) : (
            visible.map((row) => (
              <TraceWaterfallRow key={row.spanId} row={row} selectedSpanId={selectedSpanId} onSelect={onSelect} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};

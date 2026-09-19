import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { layoutTraceSpans } from '../../lib/trace-layout';
import { TraceWaterfallRow, WATERFALL_GRID } from './trace-waterfall-row';
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
    <Card className="min-w-0">
      <CardContent className="space-y-2 overflow-x-auto">
        <InputGroup>
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
        <div className="min-w-lg space-y-0.5">
          {/* 没有列标题：每行是一个 Button，它的 aria-label 已经带了名称，读屏不会把这里当表头。
              刻度尺只压在柱子那一列上，跨整卡宽度的话标签和柱子就差出一个名称列。 */}
          <div className={WATERFALL_GRID}>
            <WaterfallRuler className="col-start-2" totalDurationMs={totalDurationMs} />
          </div>
          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
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

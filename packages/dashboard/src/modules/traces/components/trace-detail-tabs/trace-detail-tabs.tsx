import { m } from '@aio-proxy/i18n';
import type { DashboardTraceDetail, DashboardTracePercentile, DashboardTraceSpan } from '@aio-proxy/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import { useState } from 'react';

import { useTraceWireQuery } from '../../hooks/use-trace-wire-query';
import type { TraceFilterPatch } from '../../lib/trace-search';
import { SpanDetailPanel } from '../span-detail-panel';
import { SpanWaterfall } from '../span-waterfall';
import { TraceWireTab } from './trace-wire-tab';

interface TraceDetailTabsProps {
  readonly detail: DashboardTraceDetail;
  readonly selectedSpan: DashboardTraceSpan | undefined;
  readonly comparison?: DashboardTracePercentile | null;
  readonly onSpanSelect: (spanId: string) => void;
  readonly onFilter: (patch: TraceFilterPatch) => void;
}

export const TraceDetailTabs: React.FC<TraceDetailTabsProps> = ({
  detail,
  selectedSpan,
  comparison,
  onSpanSelect,
  onFilter,
}) => {
  const [tab, setTab] = useState('detail');
  // 两个 tab 共用一份抓包（同一个 key，TanStack Query 自己去重），并且只在其中之一打开时才去读日志。
  const wireQuery = useTraceWireQuery(detail.trace.traceId, tab === 'request' || tab === 'response');

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-w-0">
      <TabsList variant="line" aria-label={m['dashboard.traces.detail_title']()}>
        <TabsTrigger value="detail">{m['dashboard.traces.detail_tab']()}</TabsTrigger>
        <TabsTrigger value="request">{m['dashboard.traces.request_tab']()}</TabsTrigger>
        <TabsTrigger value="response">{m['dashboard.traces.response_tab']()}</TabsTrigger>
      </TabsList>
      <TabsContent
        value="detail"
        className="mt-4 grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)]"
      >
        <SpanWaterfall spans={detail.spans} selectedSpanId={selectedSpan?.spanId} onSelect={onSpanSelect} />
        <SpanDetailPanel
          span={selectedSpan}
          trace={detail.trace}
          spans={detail.spans}
          comparison={comparison}
          onFilter={onFilter}
        />
      </TabsContent>
      <TabsContent value="request" className="mt-4">
        <TraceWireTab side="request" detail={detail} wire={wireQuery} />
      </TabsContent>
      <TabsContent value="response" className="mt-4">
        <TraceWireTab side="response" detail={detail} wire={wireQuery} />
      </TabsContent>
    </Tabs>
  );
};

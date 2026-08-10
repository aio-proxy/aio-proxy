import { m } from '@aio-proxy/i18n';
import type { DashboardTraceDetail, DashboardTraceSpan } from '@aio-proxy/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';

import { SpanDetailPanel } from '../span-detail-panel';
import { SpanWaterfall } from '../span-waterfall';
import { TraceHttpDiagnostics } from '../trace-http-diagnostics';

interface TraceDetailTabsProps {
  readonly detail: DashboardTraceDetail;
  readonly selectedSpan: DashboardTraceSpan | undefined;
  readonly onSpanSelect: (spanId: string) => void;
}

export const TraceDetailTabs: React.FC<TraceDetailTabsProps> = ({ detail, selectedSpan, onSpanSelect }) => (
  <Tabs defaultValue="detail" className="min-w-0">
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
      <SpanDetailPanel span={selectedSpan} />
    </TabsContent>
    <TabsContent value="request" className="mt-4">
      <TraceHttpDiagnostics side="request" diagnostics={detail.diagnostics?.request} />
    </TabsContent>
    <TabsContent value="response" className="mt-4">
      <TraceHttpDiagnostics side="response" diagnostics={detail.diagnostics?.response} />
    </TabsContent>
  </Tabs>
);

import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { formatTraceDuration, formatTraceResultDetails } from '../../trace-formatters';
import { TraceStatus } from '../trace-status';

interface SpanDetailPanelProps {
  readonly span: DashboardTraceSpan | undefined;
}

export const SpanDetailPanel: React.FC<SpanDetailPanelProps> = ({ span }) => {
  const missing = m['dashboard.traces.not_available']();
  const resultDetails =
    span === undefined ? undefined : formatTraceResultDetails({ errorType: span.errorType, errorCode: span.errorCode });

  return (
    <Card data-testid="span-detail-panel" className="min-w-0">
      <CardHeader>
        <CardTitle>{m['dashboard.traces.span_details']()}</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {span === undefined ? (
          <p className="text-muted-foreground">{missing}</p>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <div className="font-heading text-base font-medium wrap-break-word">{span.name}</div>
                <div className="text-xs text-muted-foreground">{span.kind}</div>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                {[
                  [m['dashboard.traces.trace_id'](), span.traceId],
                  [m['dashboard.traces.span_id'](), span.spanId],
                  [m['dashboard.traces.parent_span_id'](), span.parentSpanId],
                  [m['dashboard.traces.status'](), <TraceStatus key="status" item={span} className="justify-end" />],
                  [m['dashboard.traces.started_at'](), new Date(span.startedAt).toLocaleString()],
                  [
                    m['dashboard.traces.ended_at'](),
                    span.endedAt === null ? undefined : new Date(span.endedAt).toLocaleString(),
                  ],
                  [m['dashboard.traces.duration'](), formatTraceDuration(span.durationMs)],
                  [m['dashboard.traces.result_details'](), resultDetails],
                ].map(([label, value]) => (
                  <div className="contents" key={label as string}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 text-right wrap-break-word">{value ?? missing}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <Tabs defaultValue="attributes">
              <TabsList className="w-full" aria-label={m['dashboard.traces.span_data']()}>
                <TabsTrigger value="attributes">{m['dashboard.traces.attributes']()}</TabsTrigger>
                <TabsTrigger value="events">{m['dashboard.traces.events']()}</TabsTrigger>
                <TabsTrigger value="links">{m['dashboard.traces.links']()}</TabsTrigger>
              </TabsList>
              <TabsContent value="attributes">
                <pre className="max-h-80 overflow-auto rounded-2xl bg-muted p-3 text-xs wrap-break-word whitespace-pre-wrap">
                  {JSON.stringify(span.attributes, null, 2)}
                </pre>
              </TabsContent>
              <TabsContent value="events" className="space-y-2">
                {span.events.length === 0
                  ? missing
                  : span.events.map((event, index) => (
                      <div className="rounded-2xl border p-3" key={`${event.timestamp}-${event.name}-${index}`}>
                        <div className="font-medium">{event.name}</div>
                        <time className="text-xs text-muted-foreground">
                          {new Date(event.timestamp).toLocaleString()}
                        </time>
                        <pre className="mt-2 overflow-auto text-xs wrap-break-word whitespace-pre-wrap">
                          {JSON.stringify(event.attributes, null, 2)}
                        </pre>
                      </div>
                    ))}
              </TabsContent>
              <TabsContent value="links" className="space-y-2">
                {span.links.length === 0
                  ? missing
                  : span.links.map((link, index) => (
                      <div className="rounded-2xl border p-3" key={`${link.traceId}-${link.spanId}-${index}`}>
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                          <dt className="text-muted-foreground">{m['dashboard.traces.trace_id']()}</dt>
                          <dd className="text-right wrap-break-word">{link.traceId}</dd>
                          <dt className="text-muted-foreground">{m['dashboard.traces.span_id']()}</dt>
                          <dd className="text-right wrap-break-word">{link.spanId}</dd>
                        </dl>
                        <pre className="mt-2 overflow-auto text-xs wrap-break-word whitespace-pre-wrap">
                          {JSON.stringify(link.attributes, null, 2)}
                        </pre>
                      </div>
                    ))}
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
};

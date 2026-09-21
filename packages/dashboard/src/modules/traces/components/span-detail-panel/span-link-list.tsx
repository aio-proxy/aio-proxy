import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';

interface SpanLinkListProps {
  readonly links: DashboardTraceSpan['links'];
}

// 面板按设计稿只留四块，链接不在其中；但它和 events 不一样，入站带 traceparent 时是真有值的
// （`request-trace-recorder.ts` 从请求头解出来写进去），所以有值才补一块，没值不占位。
export const SpanLinkList: React.FC<SpanLinkListProps> = ({ links }) => (
  <section className="space-y-2" data-testid="span-link-list">
    <h3 className="text-xs text-muted-foreground">{m['dashboard.traces.links']()}</h3>
    <div className="grid gap-px overflow-hidden rounded-md bg-border">
      {links.map((link, index) => (
        <div className="bg-card px-2.5 py-1.5" key={`${link.traceId}-${link.spanId}-${index}`}>
          <p className="font-mono text-xs break-all">
            {link.traceId} · {link.spanId}
          </p>
          <pre className="mt-1 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(link.attributes, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  </section>
);

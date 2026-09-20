import { m } from '@aio-proxy/i18n';
import type { DashboardTraceWireHop } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';

import { formatDuration } from '@/lib/format-duration';

import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';

interface TraceWirePanelProps {
  readonly side: 'request' | 'response';
  readonly hop: DashboardTraceWireHop | undefined;
}

export const TraceWirePanel: React.FC<TraceWirePanelProps> = ({ side, hop }) => {
  // 抓包按方向逐条落盘，一跳可能只留下了一半：span 里有这一跳，日志里没有这个方向。
  const request = side === 'request' ? hop?.request : undefined;
  const response = side === 'response' ? hop?.response : undefined;
  const capture = request ?? response;

  if (capture === undefined) {
    return (
      <p className="rounded-2xl bg-muted p-4 text-sm text-muted-foreground" role="status">
        {m['dashboard.traces.wire_hop_empty']()}
      </p>
    );
  }

  const headers = Object.entries(capture.headers ?? {});
  const body = capture.body;

  return (
    <div className="space-y-6">
      {request !== undefined && (
        <p className="rounded-2xl bg-muted p-4 font-mono text-sm break-all">
          {request.method ?? TRACE_PLACEHOLDER} {request.url ?? TRACE_PLACEHOLDER}
        </p>
      )}
      {response !== undefined && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-muted p-4 text-sm">
          <span className="font-mono">HTTP {response.statusCode ?? TRACE_PLACEHOLDER}</span>
          <span className="text-muted-foreground tabular-nums">
            {response.durationMs === undefined ? TRACE_PLACEHOLDER : formatDuration(response.durationMs)}
          </span>
          {response.errorType !== undefined && <Badge variant="destructive">{response.errorType}</Badge>}
        </div>
      )}
      {headers.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-heading text-base font-semibold">{m['dashboard.traces.headers']()}</h2>
          <dl className="rounded-2xl bg-muted p-4 text-sm">
            {headers.map(([name, value]) => (
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-4 py-1" key={name}>
                <dt className="font-mono text-xs text-muted-foreground">{name}</dt>
                <dd className="text-right wrap-break-word">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {body !== undefined && (
        <section className="space-y-3">
          <h2 className="font-heading text-base font-semibold">{m['dashboard.traces.body']()}</h2>
          {/* 三种残缺都用这一句：服务端把超过单跳单方向上限的尾巴裁掉了（truncated），
              抓包收完了但结果不是 complete（cancelled / error），或者**压根没看到终止事件**。
              最后这种就是 outcome 缺失：`body-tap.ts` 四个 terminal 调用点全都带 outcome，
              所以有正文却没有 outcome 只可能是流还在跑、或者那行日志在崩溃/半截读里丢了 ——
              两种都不是完整正文，按完整展示会让人拿着半截 body 去查问题。 */}
          {(body.truncated === true || body.outcome !== 'complete') && (
            <p className="text-sm text-muted-foreground" role="status">
              {m['dashboard.traces.wire_body_truncated']()}
            </p>
          )}
          <pre className="max-h-96 overflow-auto rounded-2xl bg-muted p-3 font-mono text-xs wrap-break-word whitespace-pre-wrap">
            {body.text}
          </pre>
        </section>
      )}
    </div>
  );
};

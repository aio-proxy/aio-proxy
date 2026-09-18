import { m } from '@aio-proxy/i18n';
import type { DashboardTraceDetail } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useState } from 'react';

import type { useTraceWireQuery } from '../../hooks/use-trace-wire-query';
import { toTraceHopChips } from '../../lib/trace-hops';
import { TraceHopSelector } from '../trace-hop-selector';
import { TraceHttpDiagnostics } from '../trace-http-diagnostics';
import { TraceWirePanel } from '../trace-wire-panel';
import { TraceWireUnavailable } from '../trace-wire-unavailable';

interface TraceWireTabProps {
  readonly side: 'request' | 'response';
  readonly detail: DashboardTraceDetail;
  readonly wire: ReturnType<typeof useTraceWireQuery>;
}

/**
 * 收下整个 query 而不只是 `data`：还在读、读失败、读回来了但没有这一跳，
 * 是三件不同的事，只看 `data === undefined` 会把前两件都说成「这一跳没有抓包记录」
 * —— 端点 500 的时候那是在替用户的数据撒谎。
 */
export const TraceWireTab: React.FC<TraceWireTabProps> = ({ side, detail, wire }) => {
  const hops = toTraceHopChips({ spans: detail.spans, trace: detail.trace });
  const [selectedHopId, setSelectedHopId] = useState<string>();
  const selected = hops.find((hop) => hop.id === selectedHopId) ?? hops[0];

  return (
    <div className="space-y-4">
      <TraceHopSelector hops={hops} selectedHopId={selected?.id ?? ''} onSelect={setSelectedHopId} />
      {/* 入站的响应体不在抓包里（只记上游三个方向），所以那一格换成常开的 allowlist 诊断 —— 它不依赖 debug，也不依赖这次请求。 */}
      {side === 'response' && selected?.kind === 'inbound' ? (
        <TraceHttpDiagnostics side="response" diagnostics={detail.diagnostics?.response} />
      ) : wire.isPending ? (
        <Skeleton className="h-48 w-full" role="status" aria-label={m['dashboard.traces.detail_loading']()} />
      ) : wire.isError ? (
        <div className="space-y-3 rounded-2xl bg-muted p-4" role="alert">
          <p className="text-sm text-muted-foreground">{m['dashboard.traces.wire_error']()}</p>
          <Button size="sm" variant="outline" onClick={() => void wire.refetch()}>
            {m['dashboard.traces.refresh']()}
          </Button>
        </div>
      ) : wire.data.available === false ? (
        <TraceWireUnavailable reason={wire.data.reason} retentionDays={wire.data.retentionDays} />
      ) : (
        <TraceWirePanel side={side} hop={wire.data.hops.find((hop) => hop.id === selected?.id)} />
      )}
    </div>
  );
};

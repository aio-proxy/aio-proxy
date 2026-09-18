import type { DashboardTraceDetail, DashboardTraceWireResponse } from '@aio-proxy/types';
import { useState } from 'react';

import { toTraceHopChips } from '../../lib/trace-hops';
import { TraceHopSelector } from '../trace-hop-selector';
import { TraceHttpDiagnostics } from '../trace-http-diagnostics';
import { TraceWirePanel } from '../trace-wire-panel';
import { TraceWireUnavailable } from '../trace-wire-unavailable';

interface TraceWireTabProps {
  readonly side: 'request' | 'response';
  readonly detail: DashboardTraceDetail;
  readonly wire: DashboardTraceWireResponse | undefined;
}

export const TraceWireTab: React.FC<TraceWireTabProps> = ({ side, detail, wire }) => {
  const hops = toTraceHopChips({ spans: detail.spans, trace: detail.trace });
  const [selectedHopId, setSelectedHopId] = useState<string>();
  const selected = hops.find((hop) => hop.id === selectedHopId) ?? hops[0];

  return (
    <div className="space-y-4">
      <TraceHopSelector hops={hops} selectedHopId={selected?.id ?? ''} onSelect={setSelectedHopId} />
      {/* 入站的响应体不在抓包里（只记上游三个方向），所以那一格换成常开的 allowlist 诊断 —— 它不依赖 debug。 */}
      {side === 'response' && selected?.kind === 'inbound' ? (
        <TraceHttpDiagnostics side="response" diagnostics={detail.diagnostics?.response} />
      ) : wire?.available === false ? (
        <TraceWireUnavailable reason={wire.reason} retentionDays={wire.retentionDays} />
      ) : (
        <TraceWirePanel side={side} hop={wire?.hops.find((hop) => hop.id === selected?.id)} />
      )}
    </div>
  );
};

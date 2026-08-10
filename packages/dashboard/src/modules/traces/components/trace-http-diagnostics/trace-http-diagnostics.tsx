import { m } from '@aio-proxy/i18n';
import type { DashboardTraceDiagnostics } from '@aio-proxy/types';

import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';

interface TraceHttpDiagnosticsProps {
  readonly side: 'request' | 'response';
  readonly diagnostics: DashboardTraceDiagnostics['request'] | DashboardTraceDiagnostics['response'];
}

export const TraceHttpDiagnostics: React.FC<TraceHttpDiagnosticsProps> = ({ side, diagnostics }) => {
  if (diagnostics === undefined) {
    return (
      <p className="rounded-2xl bg-muted p-4 text-sm text-muted-foreground" role="status">
        {side === 'request'
          ? m['dashboard.traces.request_diagnostics_unavailable']()
          : m['dashboard.traces.response_diagnostics_unavailable']()}
      </p>
    );
  }

  const isRequest = side === 'request' && 'method' in diagnostics;
  const metadata = isRequest
    ? [
        [m['dashboard.traces.protocol'](), diagnostics.protocol],
        [m['dashboard.traces.method'](), diagnostics.method],
      ]
    : [[m['dashboard.traces.http_status'](), 'statusCode' in diagnostics ? diagnostics.statusCode : undefined]];
  const headers = [
    [m['dashboard.traces.content_type'](), diagnostics.contentType],
    ...(isRequest ? [['User-Agent', diagnostics.userAgent]] : []),
  ];

  return (
    <div className="space-y-6">
      <dl className="grid gap-3 sm:grid-cols-2">
        {metadata.map(([label, value]) => (
          <div className="rounded-2xl bg-muted p-4" key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 wrap-break-word">{value ?? TRACE_PLACEHOLDER}</dd>
          </div>
        ))}
      </dl>
      <section className="space-y-3">
        <h2 className="font-heading text-base font-semibold">{m['dashboard.traces.headers']()}</h2>
        <dl className="rounded-2xl bg-muted p-4 text-sm">
          {headers.map(([label, value]) => (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-4 py-1" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right wrap-break-word">{value ?? TRACE_PLACEHOLDER}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="space-y-3">
        <h2 className="font-heading text-base font-semibold">{m['dashboard.traces.body']()}</h2>
        <dl className="rounded-2xl bg-muted p-4 text-sm">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-4">
            <dt className="text-muted-foreground">{m['dashboard.traces.content_length_bytes']()}</dt>
            <dd className="text-right tabular-nums">{diagnostics.contentLengthBytes ?? TRACE_PLACEHOLDER}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
};

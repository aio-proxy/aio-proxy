import { createTraceStore, openDb } from '@aio-proxy/core/db';
import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';

// Legacy projection of the trace store back into the {requests, usages} shape
// the protocol HTTP tests assert on. The pipeline now writes traces (spans)
// from TraceStore persistence, so this reads root traces +
// their attempt spans and reshapes them to the historical row layout. Kept as
// one shared helper so each protocol test-support file stays tiny.

type RecordedAttempt = {
  readonly index: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: string;
  readonly protocol?: string;
  readonly outcome: 'success' | 'failure' | 'cancelled';
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly durationMs: number;
};

type RecordedRequest = {
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly requestedModelId: string;
  readonly outcome: 'success' | 'failure' | 'cancelled' | 'interrupted';
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
  readonly errorCode?: string;
  readonly attempts: readonly RecordedAttempt[];
};

const ATTEMPT_SPAN = 'aio_proxy.provider.attempt';
const UNPARSED_REQUESTED_MODEL_ID = '<unparsed>';

export async function recorded(home: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = openDb({ home });
    try {
      const store = createTraceStore(handle.db);
      const roots = store.list({ page: 1, pageSize: 100 }).items;
      if (roots.length > 0 && roots.every((root) => root.endedAt !== null)) {
        const ordered = [...roots].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        const requests = ordered.map((root) => toRequest(root, store.find(root.traceId)?.spans ?? []));
        const usages = ordered.flatMap((root) => (root.usage === undefined ? [] : [root.usage]));
        return { requests, usages };
      }
    } finally {
      handle.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('request row was not recorded');
}

function toRequest(root: DashboardTraceSummary, spans: readonly DashboardTraceSpan[]): RecordedRequest {
  const attempts = spans
    .filter((span) => span.name === ATTEMPT_SPAN)
    .map(toAttempt)
    .sort((a, b) => a.index - b.index);
  return {
    requestId: root.requestId,
    inboundProtocol: root.inboundProtocol,
    requestedModelId: root.requestedModelId ?? UNPARSED_REQUESTED_MODEL_ID,
    outcome: root.terminationReason ?? 'success',
    ...(root.finalProviderId === undefined ? {} : { finalProviderId: root.finalProviderId }),
    ...(root.finalModelId === undefined ? {} : { finalModelId: root.finalModelId }),
    ...(root.finalHttpStatus === undefined ? {} : { finalStatusCode: root.finalHttpStatus }),
    ...(root.errorCode === undefined ? {} : { errorCode: root.errorCode }),
    attempts,
  };
}

function toAttempt(span: DashboardTraceSpan): RecordedAttempt {
  const attrs = span.attributes;
  const protocol = str(attrs, 'aio_proxy.protocol.target');
  const statusCode = num(attrs, 'http.status_code');
  const errorCode = str(attrs, 'aio_proxy.error.code');
  return {
    index: num(attrs, 'aio_proxy.attempt.index') ?? 0,
    providerId: str(attrs, 'aio_proxy.provider.id') ?? '',
    modelId: str(attrs, 'gen_ai.response.model') ?? '',
    providerKind: str(attrs, 'aio_proxy.provider.kind') ?? '',
    outcome: (span.terminationReason ?? 'success') as RecordedAttempt['outcome'],
    durationMs: span.durationMs,
    ...(protocol === undefined ? {} : { protocol }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function str(attrs: DashboardTraceSpan['attributes'], key: string): string | undefined {
  const value = attrs[key];
  return typeof value === 'string' ? value : undefined;
}

function num(attrs: DashboardTraceSpan['attributes'], key: string): number | undefined {
  const value = attrs[key];
  return typeof value === 'number' ? value : undefined;
}

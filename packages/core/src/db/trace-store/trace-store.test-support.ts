import type { StoredSpan, TraceCompletion, TraceRootStart } from './types';

export const TRACE_ID = 'a'.repeat(32);
export const ROOT_SPAN_ID = 'b'.repeat(16);
export const STARTED_AT = new Date('2026-07-24T10:00:00.000Z');
export const ENDED_AT = new Date('2026-07-24T10:00:00.100Z');

const CHILD_SPAN_ID = 'c'.repeat(16);

export function rootStart(overrides: Partial<TraceRootStart> = {}): TraceRootStart {
  const requestId = overrides.requestId ?? 'request-a';
  return {
    ...overrides,
    traceId: overrides.traceId ?? TRACE_ID,
    spanId: overrides.spanId ?? ROOT_SPAN_ID,
    requestId,
    inboundProtocol: overrides.inboundProtocol ?? 'openai-compatible',
    name: overrides.name ?? 'aio_proxy.request',
    kind: overrides.kind ?? 1,
    startedAt: overrides.startedAt ?? STARTED_AT,
    statusCode: overrides.statusCode ?? 0,
    attributes: {
      'aio_proxy.request.id': requestId,
      'aio_proxy.protocol.inbound': 'openai-compatible',
      ...overrides.attributes,
    },
    events: overrides.events ?? [],
    links: overrides.links ?? [],
  };
}

export function rootSpan(overrides: Partial<StoredSpan> = {}): StoredSpan {
  return {
    traceId: TRACE_ID,
    spanId: ROOT_SPAN_ID,
    name: 'aio_proxy.request',
    kind: 1,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    statusCode: 0,
    attributes: {
      'aio_proxy.request.id': 'request-a',
      'aio_proxy.protocol.inbound': 'openai-compatible',
      'gen_ai.response.model': 'model-b',
      'aio_proxy.route.final_provider_id': 'provider-b',
    },
    events: [],
    links: [],
    ...overrides,
  };
}

export function attemptSpan(overrides: Partial<StoredSpan> = {}): StoredSpan {
  return {
    traceId: TRACE_ID,
    spanId: CHILD_SPAN_ID,
    parentSpanId: ROOT_SPAN_ID,
    name: 'aio_proxy.provider.attempt',
    kind: 2,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    statusCode: 0,
    attributes: {
      'aio_proxy.attempt.index': 0,
      'aio_proxy.provider.id': 'provider-b',
      'gen_ai.request.model': 'model-b',
    },
    events: [],
    links: [],
    ...overrides,
  };
}

export function completion(overrides: Partial<TraceCompletion> = {}): TraceCompletion {
  return {
    traceId: TRACE_ID,
    rootSpanId: ROOT_SPAN_ID,
    spans: [rootSpan(), attemptSpan()],
    summary: {
      finalProviderId: 'provider-b',
      finalModelId: 'model-b',
      finalHttpStatus: 200,
      usage: {
        providerId: 'provider-b',
        modelId: 'model-b',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 20,
        estimatedCostUsd: 0.1,
      },
    },
    ...overrides,
  };
}

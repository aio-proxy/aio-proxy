import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { readSpanMetrics } from './span-metrics';

const trace: DashboardTraceSummary = {
  traceId: 'a'.repeat(32),
  rootSpanId: 'b'.repeat(16),
  requestId: 'request-a',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:03.420Z',
  durationMs: 3_420,
  ttftMs: 1_820,
  otelStatusCode: 'UNSET',
  inboundProtocol: 'anthropic-messages',
  requestedModelId: 'claude-sonnet-4-6',
  finalProviderId: 'anthropic-backup',
  finalModelId: 'claude-sonnet-4-6-20260101',
  finalHttpStatus: 200,
  usage: {
    providerId: 'anthropic-backup',
    modelId: 'claude-sonnet-4-6-20260101',
    inputTokens: 8_412,
    outputTokens: 1_096,
  },
};

const createSpan = (span: Partial<DashboardTraceSpan>): DashboardTraceSpan => ({
  traceId: trace.traceId,
  spanId: 'c'.repeat(16),
  name: 'aio_proxy.provider.attempt',
  kind: 'CLIENT',
  startedAt: '2026-07-12T08:00:00.010Z',
  endedAt: '2026-07-12T08:00:00.090Z',
  durationMs: 80,
  otelStatusCode: 'UNSET',
  attributes: {},
  events: [],
  links: [],
  ...span,
});

test('reads provider, model, and latency straight off an attempt span', () => {
  const span = createSpan({
    parentSpanId: trace.rootSpanId,
    durationMs: 2_400,
    attributes: {
      'http.status_code': 429,
      'aio_proxy.provider.id': 'anthropic-primary',
      'gen_ai.response.model': 'claude-sonnet-4-6-20260101',
      'gen_ai.request.model': 'claude-sonnet-4-6',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 34,
      'aio_proxy.response.ttft_ms': 900,
      'aio_proxy.response.upstream_headers_ms': 640,
    },
  });

  expect(readSpanMetrics({ span, spans: [span], trace })).toEqual({
    httpStatus: 429,
    providerId: 'anthropic-primary',
    modelId: 'claude-sonnet-4-6-20260101',
    durationMs: 2_400,
    ttftMs: 900,
    upstreamMs: 640,
    inputTokens: 12,
    outputTokens: 34,
    attemptCount: 1,
  });
});

test('falls back to the trace row when the root span carries no attributes', () => {
  const root = createSpan({ spanId: trace.rootSpanId, name: 'aio_proxy.request', kind: 'SERVER', durationMs: 3_420 });

  expect(readSpanMetrics({ span: root, spans: [root], trace })).toEqual({
    httpStatus: 200,
    providerId: 'anthropic-backup',
    modelId: 'claude-sonnet-4-6-20260101',
    durationMs: 3_420,
    ttftMs: 1_820,
    upstreamMs: undefined,
    inputTokens: 8_412,
    outputTokens: 1_096,
    attemptCount: undefined,
  });
});

test('keeps trace fallbacks off non-root spans so a child never borrows the request totals', () => {
  const child = createSpan({ spanId: 'd'.repeat(16), name: 'aio_proxy.response.egress', kind: 'INTERNAL' });

  const metrics = readSpanMetrics({ span: child, spans: [child], trace });

  expect(metrics.ttftMs).toBeUndefined();
  expect(metrics.inputTokens).toBeUndefined();
  expect(metrics.outputTokens).toBeUndefined();
  // provider / model / http status stay trace-wide facts, so those still fall back.
  expect(metrics.providerId).toBe('anthropic-backup');
  expect(metrics.httpStatus).toBe(200);
});

test('counts only provider attempt spans as attempts', () => {
  const spans = [
    createSpan({ spanId: trace.rootSpanId, name: 'aio_proxy.request', kind: 'SERVER' }),
    createSpan({ spanId: '1'.repeat(16), name: 'aio_proxy.route.resolve', kind: 'INTERNAL' }),
    createSpan({ spanId: '2'.repeat(16), name: 'aio_proxy.provider.attempt' }),
    createSpan({ spanId: '3'.repeat(16), name: 'aio_proxy.provider.attempt' }),
    createSpan({ spanId: '4'.repeat(16), name: 'gen_ai.client.inference' }),
  ];

  expect(readSpanMetrics({ span: spans[2]!, spans, trace }).attemptCount).toBe(2);
});

test('rejects attribute values that are not finite numbers or non-empty strings', () => {
  const span = createSpan({
    attributes: {
      'http.status_code': 'nope',
      'aio_proxy.provider.id': '',
      'aio_proxy.route.final_provider_id': '',
      'gen_ai.response.model': false,
      'gen_ai.usage.input_tokens': Number.NaN,
      'aio_proxy.response.upstream_headers_ms': Number.POSITIVE_INFINITY,
    },
  });

  const metrics = readSpanMetrics({ span, spans: [span], trace: { ...trace, finalProviderId: undefined } });

  expect(metrics.httpStatus).toBe(200);
  expect(metrics.providerId).toBeUndefined();
  expect(metrics.modelId).toBe('claude-sonnet-4-6-20260101');
  expect(metrics.inputTokens).toBeUndefined();
  expect(metrics.upstreamMs).toBeUndefined();
});

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
      'http.response.status_code': 429,
      'aio_proxy.provider.id': 'anthropic-primary',
      'aio_proxy.attempt.model_id': 'claude-sonnet-4-6-20260101',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 34,
      'aio_proxy.attempt.ttft_ms': 900,
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
    // No trace fallback for the status code: it belongs to whichever span recorded it.
    httpStatus: undefined,
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

test('still falls back to the trace row when the root span records unusable numbers', () => {
  const root = createSpan({
    spanId: trace.rootSpanId,
    name: 'aio_proxy.request',
    kind: 'SERVER',
    attributes: {
      'aio_proxy.response.ttft_ms': Number.NaN,
      'gen_ai.usage.input_tokens': Number.NaN,
      'gen_ai.usage.output_tokens': Number.POSITIVE_INFINITY,
    },
  });

  const metrics = readSpanMetrics({ span: root, spans: [root], trace });

  expect(metrics.ttftMs).toBe(1_820);
  expect(metrics.inputTokens).toBe(8_412);
  expect(metrics.outputTokens).toBe(1_096);
});

test('keeps trace fallbacks off non-root spans so a child never borrows the request totals', () => {
  const child = createSpan({ spanId: 'd'.repeat(16), name: 'aio_proxy.request.parse', kind: 'INTERNAL' });

  const metrics = readSpanMetrics({ span: child, spans: [child], trace });

  expect(metrics.ttftMs).toBeUndefined();
  expect(metrics.inputTokens).toBeUndefined();
  expect(metrics.outputTokens).toBeUndefined();
  // A parse span never records a status code; the trace's final code is not its outcome.
  expect(metrics.httpStatus).toBeUndefined();
  // provider / model stay trace-wide facts, so those still fall back.
  expect(metrics.providerId).toBe('anthropic-backup');
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
      'http.response.status_code': 'nope',
      'aio_proxy.provider.id': '',
      'aio_proxy.route.final_provider_id': '',
      'aio_proxy.attempt.model_id': false,
      'gen_ai.usage.input_tokens': Number.NaN,
      'aio_proxy.response.upstream_headers_ms': Number.POSITIVE_INFINITY,
    },
  });

  const metrics = readSpanMetrics({ span, spans: [span], trace: { ...trace, finalProviderId: undefined } });

  expect(metrics.httpStatus).toBeUndefined();
  expect(metrics.providerId).toBeUndefined();
  expect(metrics.modelId).toBe('claude-sonnet-4-6-20260101');
  expect(metrics.inputTokens).toBeUndefined();
  expect(metrics.upstreamMs).toBeUndefined();
});

// 库里现存的 trace 全是老 key 写的，不迁移数据 —— 兜底就是迁移。
test('still reads the legacy attempt keys recorded before the rename', () => {
  const span = createSpan({
    parentSpanId: trace.rootSpanId,
    attributes: {
      'http.status_code': 503,
      'gen_ai.response.model': 'claude-sonnet-4-6-20260101',
      'aio_proxy.response.ttft_ms': 700,
    },
  });
  const metrics = readSpanMetrics({ span, spans: [span], trace });

  expect(metrics.httpStatus).toBe(503);
  expect(metrics.modelId).toBe('claude-sonnet-4-6-20260101');
  expect(metrics.ttftMs).toBe(700);
});

// 兜底链的顺序是有含义的，而只带一个 key 的夹具证明不了顺序 —— 两个 key 同时在场才行。
// 两个 key 同时出现是真实存在的形状，但来自任务 8 之前的 GenAI/inference 行：它自己发
// gen_ai.request.model，而 final_model_id 列被 mergeAttributes 挂回成 gen_ai.response.model。
// （老的 attempt 行只发过 gen_ai.response.model，model_id 列是 NULL，所以只有一个 key。）
// 不论哪种来源，一格里两个都在时该显示的是「这一跳用的模型」，也就是 attemptModelId。
test('prefers the attempt model over the response model when a span carries both', () => {
  const span = createSpan({
    attributes: {
      'aio_proxy.attempt.model_id': 'attempt-candidate-model',
      'gen_ai.response.model': 'genai-answered-model',
      'gen_ai.request.model': 'inbound-requested-model',
    },
  });

  expect(readSpanMetrics({ span, spans: [span], trace }).modelId).toBe('attempt-candidate-model');
});

// 同理：attempt span 上两份 TTFT 都在场时，要显示这一跳自己的那份，而不是请求级的那份。
// 一条失败转移的 attempt 和整个请求的 TTFT 差着前面几跳烧掉的时间。
test('prefers the attempt TTFT over the request-level TTFT when a span carries both', () => {
  const span = createSpan({
    parentSpanId: trace.rootSpanId,
    attributes: {
      'aio_proxy.attempt.ttft_ms': 120,
      'aio_proxy.response.ttft_ms': 980,
    },
  });

  expect(readSpanMetrics({ span, spans: [span], trace }).ttftMs).toBe(120);
});

// 推理 span 的 TTFT 走语义约定的 key、单位是秒。少了换算，选中那条 span 时格子是「—」。
test('reads the inference span TTFT from the GenAI attribute and converts seconds to milliseconds', () => {
  const inference = createSpan({
    parentSpanId: trace.rootSpanId,
    kind: 'CLIENT',
    name: 'chat claude-sonnet-4-6',
    attributes: { 'gen_ai.response.time_to_first_chunk': 0.612 },
  });

  expect(readSpanMetrics({ span: inference, spans: [inference], trace }).ttftMs).toBe(612);
});

// 毫秒的那两个 key 优先：attempt span 上两者不会同时出现，但兜底链的顺序得钉住，
// 否则把秒当毫秒读会让 TTFT 差三个数量级而不报错。
test('prefers the millisecond TTFT keys over the GenAI seconds one', () => {
  const span = createSpan({
    parentSpanId: trace.rootSpanId,
    attributes: { 'aio_proxy.attempt.ttft_ms': 120, 'gen_ai.response.time_to_first_chunk': 9.9 },
  });

  expect(readSpanMetrics({ span, spans: [span], trace }).ttftMs).toBe(120);
});

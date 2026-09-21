import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { toTraceHopChips } from './trace-hops';

const trace: DashboardTraceSummary = {
  traceId: 'a'.repeat(32),
  rootSpanId: 'b'.repeat(16),
  requestId: 'request-a',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:03.420Z',
  durationMs: 3_420,
  otelStatusCode: 'UNSET',
  inboundProtocol: 'anthropic-messages',
  session: { source: 'claude-cli', id: 'session-a' },
};

const createSpan = (span: Partial<DashboardTraceSpan>): DashboardTraceSpan => ({
  traceId: trace.traceId,
  spanId: 'c'.repeat(16),
  name: 'aio_proxy.provider.attempt',
  kind: 'INTERNAL',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:01.000Z',
  durationMs: 1_000,
  otelStatusCode: 'UNSET',
  attributes: {},
  events: [],
  links: [],
  ...span,
});

test('puts inbound first and labels it with the session source', () => {
  const chips = toTraceHopChips({ spans: [createSpan({})], trace });

  expect(chips[0]).toEqual({
    id: 'inbound',
    label: 'claude-cli',
    kind: 'inbound',
    attemptIndex: undefined,
    status: 'success',
  });
});

test('falls back to the inbound protocol when the trace has no session', () => {
  const chips = toTraceHopChips({ spans: [], trace: { ...trace, session: undefined } });

  expect(chips).toEqual([
    { id: 'inbound', label: 'anthropic-messages', kind: 'inbound', attemptIndex: undefined, status: 'success' },
  ]);
});

test('marks inbound as failure from the trace status', () => {
  const chips = toTraceHopChips({ spans: [], trace: { ...trace, otelStatusCode: 'ERROR' } });

  expect(chips[0]?.status).toBe('failure');
});

// 4xx 的 span 状态按 HTTP 语义约定是 UNSET，只看状态码的话被拒的那一跳会显示成正常。
test('marks a 4xx hop as failure even though its OTel status is UNSET', () => {
  const chips = toTraceHopChips({
    spans: [createSpan({ attributes: { 'aio_proxy.attempt.index': 0, 'http.response.status_code': 429 } })],
    trace: { ...trace, finalHttpStatus: 404 },
  });

  expect(chips[0]?.status).toBe('failure');
  expect(chips[1]?.status).toBe('failure');
});

test('orders attempts by attempt index rather than span order', () => {
  const chips = toTraceHopChips({
    spans: [
      createSpan({
        spanId: 'd'.repeat(16),
        attributes: { 'aio_proxy.attempt.index': 1, 'aio_proxy.provider.id': 'anthropic-backup' },
      }),
      createSpan({
        spanId: 'c'.repeat(16),
        attributes: { 'aio_proxy.attempt.index': 0, 'aio_proxy.provider.id': 'anthropic-primary' },
      }),
    ],
    trace,
  });

  expect(chips.map((chip) => chip.id)).toEqual(['inbound', 'attempt-0', 'attempt-1']);
  expect(chips.map((chip) => chip.label)).toEqual(['claude-cli', 'anthropic-primary', 'anthropic-backup']);
  expect(chips.map((chip) => chip.attemptIndex)).toEqual([undefined, 0, 1]);
});

test('falls back to the hop id as label when the attempt span has no provider id', () => {
  const chips = toTraceHopChips({
    spans: [createSpan({ attributes: { 'aio_proxy.attempt.index': 1 } })],
    trace,
  });

  expect(chips[1]).toEqual({
    id: 'attempt-1',
    label: 'attempt-1',
    kind: 'attempt',
    attemptIndex: 1,
    status: 'success',
  });
});

test('reflects an attempt span ERROR status on that chip only', () => {
  const chips = toTraceHopChips({
    spans: [
      createSpan({
        spanId: 'c'.repeat(16),
        otelStatusCode: 'ERROR',
        attributes: { 'aio_proxy.attempt.index': 0, 'aio_proxy.provider.id': 'anthropic-primary' },
      }),
      createSpan({
        spanId: 'd'.repeat(16),
        attributes: { 'aio_proxy.attempt.index': 1, 'aio_proxy.provider.id': 'anthropic-backup' },
      }),
    ],
    trace,
  });

  expect(chips.map((chip) => chip.status)).toEqual(['success', 'failure', 'success']);
});

test('ignores spans that are not provider attempts', () => {
  const chips = toTraceHopChips({
    spans: [
      // 真实形状：请求级 span 不带 attempt index。原先这里给它们硬塞了 index，
      // 于是「按名字排除」看着能过，其实夹具本身不可能出现在库里。
      createSpan({ name: 'aio_proxy.request.parse', attributes: {} }),
      createSpan({ name: 'aio_proxy.inference', attributes: {} }),
      // 唯一真带 index 却不算尝试的：token-count 里被略过的候选。
      createSpan({
        name: 'aio_proxy.token_count.candidate_skipped',
        attributes: { 'aio_proxy.attempt.index': 0 },
      }),
    ],
    trace,
  });

  expect(chips.map((chip) => chip.id)).toEqual(['inbound']);
});

// 取消和「还在跑」都不是失败，但也不是成功。用布尔的时候它们一律落进 false，于是画成绿点、
// 读屏念「成功」—— 取消从失败判定里摘出去之后，这个谎才显出来。
test('keeps running and cancelled hops out of both success and failure', () => {
  const running = toTraceHopChips({ spans: [], trace: { ...trace, endedAt: null } });
  expect(running[0]?.status).toBe('running');

  const cancelled = toTraceHopChips({
    spans: [],
    trace: { ...trace, otelStatusCode: 'ERROR', terminationReason: 'cancelled' },
  });
  expect(cancelled[0]?.status).toBe('cancelled');
});

// 子 span 要等结算才落盘。还在跑时抓包已经有上游跳，选择器必须能点进去。
test('fills missing attempt chips from live wire hops while the trace is running', () => {
  const chips = toTraceHopChips({
    spans: [],
    trace: { ...trace, endedAt: null },
    wireHops: [
      { id: 'inbound', kind: 'inbound' },
      { id: 'attempt-1', kind: 'attempt', attemptIndex: 1, providerId: 'anthropic-backup' },
      { id: 'attempt-0', kind: 'attempt', attemptIndex: 0, providerId: 'anthropic-primary' },
    ],
  });

  expect(chips.map((chip) => chip.id)).toEqual(['inbound', 'attempt-0', 'attempt-1']);
  expect(chips.map((chip) => chip.label)).toEqual(['claude-cli', 'anthropic-primary', 'anthropic-backup']);
  expect(chips[1]?.status).toBe('running');
});

test('does not invent chips from wire hops after the trace has settled', () => {
  const chips = toTraceHopChips({
    spans: [],
    trace,
    wireHops: [{ id: 'attempt-0', kind: 'attempt', attemptIndex: 0, providerId: 'anthropic-primary' }],
  });

  expect(chips.map((chip) => chip.id)).toEqual(['inbound']);
});

test('keeps a streamed hop running after headers arrive until the response body terminates', () => {
  const live = toTraceHopChips({
    spans: [],
    trace: { ...trace, endedAt: null },
    wireHops: [
      {
        id: 'attempt-0',
        kind: 'attempt',
        attemptIndex: 0,
        providerId: 'anthropic-primary',
        request: { body: { text: '{}', outcome: 'complete' } },
        response: { statusCode: 200, headers: { 'content-type': 'text/event-stream' } },
      },
    ],
  });
  expect(live[1]?.status).toBe('running');

  const finished = toTraceHopChips({
    spans: [],
    trace: { ...trace, endedAt: null },
    wireHops: [
      {
        id: 'attempt-0',
        kind: 'attempt',
        attemptIndex: 0,
        providerId: 'anthropic-primary',
        request: { body: { text: '{}', outcome: 'complete' } },
        response: { statusCode: 200, body: { text: 'data: done\n', outcome: 'complete' } },
      },
    ],
  });
  expect(finished[1]?.status).toBe('success');
});

test('keeps 4xx and cancelled wire hops out of the streamed running state', () => {
  const rejected = toTraceHopChips({
    spans: [],
    trace: { ...trace, endedAt: null },
    wireHops: [{ id: 'attempt-0', kind: 'attempt', attemptIndex: 0, response: { statusCode: 429 } }],
  });
  expect(rejected[1]?.status).toBe('failure');

  const cancelled = toTraceHopChips({
    spans: [],
    trace: { ...trace, endedAt: null },
    wireHops: [
      {
        id: 'attempt-0',
        kind: 'attempt',
        attemptIndex: 0,
        request: { body: { text: '', outcome: 'cancelled' } },
      },
    ],
  });
  expect(cancelled[1]?.status).toBe('cancelled');
});

test('keeps the span chip when the same hop already exists in the wire capture', () => {
  const chips = toTraceHopChips({
    spans: [
      createSpan({
        otelStatusCode: 'ERROR',
        attributes: { 'aio_proxy.attempt.index': 0, 'aio_proxy.provider.id': 'anthropic-primary' },
      }),
    ],
    trace: { ...trace, endedAt: null },
    wireHops: [{ id: 'attempt-0', kind: 'attempt', attemptIndex: 0, providerId: 'stale-label' }],
  });

  expect(chips).toHaveLength(2);
  expect(chips[1]).toMatchObject({ id: 'attempt-0', label: 'anthropic-primary', status: 'failure' });
});

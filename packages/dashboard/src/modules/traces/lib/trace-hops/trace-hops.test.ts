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
    failed: false,
  });
});

test('falls back to the inbound protocol when the trace has no session', () => {
  const chips = toTraceHopChips({ spans: [], trace: { ...trace, session: undefined } });

  expect(chips).toEqual([
    { id: 'inbound', label: 'anthropic-messages', kind: 'inbound', attemptIndex: undefined, failed: false },
  ]);
});

test('marks inbound failed from the trace status', () => {
  const chips = toTraceHopChips({ spans: [], trace: { ...trace, otelStatusCode: 'ERROR' } });

  expect(chips[0]?.failed).toBe(true);
});

// 4xx 的 span 状态按 HTTP 语义约定是 UNSET，只看状态码的话被拒的那一跳会显示成正常。
test('marks a 4xx hop failed even though its OTel status is UNSET', () => {
  const chips = toTraceHopChips({
    spans: [createSpan({ attributes: { 'aio_proxy.attempt.index': 0, 'http.status_code': 429 } })],
    trace: { ...trace, finalHttpStatus: 404 },
  });

  expect(chips[0]?.failed).toBe(true);
  expect(chips[1]?.failed).toBe(true);
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
    failed: false,
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

  expect(chips.map((chip) => chip.failed)).toEqual([false, true, false]);
});

test('ignores spans that are not provider attempts', () => {
  const chips = toTraceHopChips({
    spans: [
      createSpan({ name: 'aio_proxy.request.parse', attributes: { 'aio_proxy.attempt.index': 0 } }),
      createSpan({ name: 'gen_ai.client.inference', attributes: { 'aio_proxy.attempt.index': 1 } }),
    ],
    trace,
  });

  expect(chips.map((chip) => chip.id)).toEqual(['inbound']);
});

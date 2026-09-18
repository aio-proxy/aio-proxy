import type { DashboardTraceDetail, DashboardTraceSpan, DashboardTraceWireResponse } from '@aio-proxy/types';
import { beforeEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TraceDetailTabs } from './trace-detail-tabs';

const mocks = rs.hoisted(() => ({
  wire: undefined as DashboardTraceWireResponse | undefined,
  state: 'success' as 'success' | 'pending' | 'error',
  enabledCalls: [] as boolean[],
  refetch: rs.fn(),
}));

rs.mock('../../hooks/use-trace-wire-query', () => ({
  useTraceWireQuery: (_traceId: string, enabled: boolean) => {
    mocks.enabledCalls.push(enabled);
    return {
      data: mocks.wire,
      isPending: mocks.state === 'pending',
      isError: mocks.state === 'error',
      refetch: mocks.refetch,
    };
  },
}));
rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));

const traceId = 'a'.repeat(32);
const attemptSpan = (spanId: string, attemptIndex: number, providerId: string): DashboardTraceSpan => ({
  traceId,
  spanId,
  name: 'aio_proxy.provider.attempt',
  kind: 'INTERNAL',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:00.100Z',
  durationMs: 100,
  otelStatusCode: 'UNSET',
  attributes: { 'aio_proxy.attempt.index': attemptIndex, 'aio_proxy.provider.id': providerId },
  events: [],
  links: [],
});

const detail: DashboardTraceDetail = {
  trace: {
    traceId,
    rootSpanId: 'b'.repeat(16),
    requestId: 'request-a',
    startedAt: '2026-07-12T08:00:00.000Z',
    endedAt: '2026-07-12T08:00:00.125Z',
    durationMs: 125,
    otelStatusCode: 'OK',
    inboundProtocol: 'openai-response',
    session: { source: 'codex-cli', id: 'session-a' },
  },
  spans: [attemptSpan('c'.repeat(16), 0, 'openai-primary'), attemptSpan('d'.repeat(16), 1, 'openai-backup')],
  diagnostics: {
    request: { protocol: 'openai-response', method: 'POST' },
    response: { statusCode: 200 },
  },
};

// chip 的可读名字末尾还带一个只给读屏的成败词，所以这里不锚右端。
const inboundChip = /^(Inbound|入站) codex-cli\b/u;
const secondAttemptChip = /^(Attempt|尝试|嘗試|試行|시도) ?2 openai-backup\b/u;

beforeEach(() => {
  mocks.wire = { available: true, hops: [] };
  mocks.state = 'success';
  mocks.enabledCalls = [];
  mocks.refetch = rs.fn();
});

test('defaults to Detail and exposes request and response tab values', () => {
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);

  expect(screen.getByRole('tab', { name: /^Detail$|^详情$/u })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/^Spans$|^Span$/u)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));
  expect(screen.getByRole('tab', { name: /^Request$|^请求$/u })).toHaveAttribute('aria-selected', 'true');

  fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));
  expect(screen.getByRole('tab', { name: /^Response$|^响应$/u })).toHaveAttribute('aria-selected', 'true');
});

test('only asks for the wire capture once one of its tabs is open', () => {
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);

  // spec 明确要求不预加载：停在详情 tab 上不该去扫一整天的日志。
  expect(mocks.enabledCalls).toEqual([false]);

  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));
  expect(mocks.enabledCalls.at(-1)).toBe(true);

  fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));
  expect(mocks.enabledCalls.at(-1)).toBe(true);

  fireEvent.click(screen.getByRole('tab', { name: /^Detail$|^详情$/u }));
  expect(mocks.enabledCalls.at(-1)).toBe(false);
});

test('lists one chip per hop from the spans and renders the selected hop capture', () => {
  mocks.wire = {
    available: true,
    hops: [
      { id: 'inbound', kind: 'inbound', request: { method: 'POST', url: 'https://proxy.local/v1/responses' } },
      {
        id: 'attempt-1',
        kind: 'attempt',
        attemptIndex: 1,
        request: { method: 'POST', url: 'https://api.openai.com/v1/responses' },
      },
    ],
  };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));

  const inbound = screen.getByRole('button', { name: inboundChip });
  expect(inbound).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('POST https://proxy.local/v1/responses')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: secondAttemptChip }));
  expect(screen.getByText('POST https://api.openai.com/v1/responses')).toBeInTheDocument();
  expect(inbound).toHaveAttribute('aria-pressed', 'false');
});

test('carries the selected hop across the request and response tabs', () => {
  mocks.wire = {
    available: true,
    hops: [
      { id: 'inbound', kind: 'inbound', request: { method: 'POST', url: 'https://proxy.local/v1/responses' } },
      {
        id: 'attempt-1',
        kind: 'attempt',
        attemptIndex: 1,
        request: { method: 'POST', url: 'https://api.openai.com/v1/responses' },
        response: { statusCode: 503 },
      },
    ],
  };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));
  fireEvent.click(screen.getByRole('button', { name: secondAttemptChip }));

  fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));

  // 认准了某一次尝试再去看它的响应是主路径。悄悄回到入站那一跳，两个 tab 在第一跳上
  // 又长得一模一样，人会以为看的就是刚选的那一跳。
  expect(screen.getByText(/HTTP 503/u)).toBeInTheDocument();
  // 回到入站的话这里画的是入站响应的 allowlist 诊断，状态码是 200。
  expect(screen.queryByText('200')).toBeNull();
});

test('falls back to the allowlist diagnostics for the inbound response, which capture never records', () => {
  mocks.wire = { available: true, hops: [] };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));

  expect(screen.getByText('200')).toBeInTheDocument();

  // 上游那一跳没有例外，抓包里没这一跳就说没有
  fireEvent.click(screen.getByRole('button', { name: secondAttemptChip }));
  expect(screen.getByRole('status')).toBeInTheDocument();
});

test('flags a partially recorded body instead of passing it off as the whole thing', () => {
  mocks.wire = {
    available: true,
    hops: [
      {
        id: 'inbound',
        kind: 'inbound',
        request: { method: 'POST', body: { text: '{"model":"gpt-5"', outcome: 'cancelled' } },
      },
    ],
  };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));

  expect(screen.getByText(/not fully recorded|未完整记录|未完整記錄/u)).toBeInTheDocument();
});

test('says nothing about truncation when the capture completed', () => {
  mocks.wire = {
    available: true,
    hops: [
      {
        id: 'inbound',
        kind: 'inbound',
        // outcome 缺失是常态，不能当成截断
        request: { method: 'POST', body: { text: '{"model":"gpt-5"}' } },
      },
    ],
  };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));

  expect(screen.queryByText(/not fully recorded|未完整记录|未完整記錄/u)).toBeNull();
});

test('waits instead of claiming the hop was never captured while the read is in flight', () => {
  mocks.state = 'pending';
  mocks.wire = undefined;
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));

  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.queryByText(/No wire capture|没有抓包记录|沒有抓包記錄/u)).toBeNull();
});

test('reports a failed read as a failure, not as a hop without capture', () => {
  mocks.state = 'error';
  mocks.wire = undefined;
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));

  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByText(/No wire capture|没有抓包记录|沒有抓包記錄/u)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /^Refresh$|^刷新$/u }));
  expect(mocks.refetch).toHaveBeenCalled();
});

test('keeps the hop chips and explains why capture is missing when it is off', () => {
  mocks.wire = { available: false, reason: 'level', hops: [] };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));

  expect(screen.getByRole('button', { name: inboundChip })).toBeInTheDocument();
  expect(screen.getByText(/server\.logging\.enabled/u)).toBeInTheDocument();
});

import type { DashboardTraceDetail, DashboardTraceSpan, DashboardTraceWireResponse } from '@aio-proxy/types';
import { beforeEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TraceDetailTabs } from './trace-detail-tabs';

const mocks = rs.hoisted(() => ({ wire: undefined as DashboardTraceWireResponse | undefined }));

rs.mock('../../hooks/use-trace-wire-query', () => ({ useTraceWireQuery: () => ({ data: mocks.wire }) }));
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

const inboundChip = /^(Inbound|入站) codex-cli$/u;
const secondAttemptChip = /^(Attempt|尝试|嘗試|試行|시도) ?2 openai-backup$/u;

beforeEach(() => {
  mocks.wire = undefined;
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

test('falls back to the allowlist diagnostics for the inbound response, which capture never records', () => {
  mocks.wire = { available: true, hops: [] };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));

  expect(screen.getByText('200')).toBeInTheDocument();

  // 上游那一跳没有例外，抓包里没这一跳就说没有
  fireEvent.click(screen.getByRole('button', { name: secondAttemptChip }));
  expect(screen.getByRole('status')).toBeInTheDocument();
});

test('keeps the hop chips and explains why capture is missing when it is off', () => {
  mocks.wire = { available: false, reason: 'level', hops: [] };
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} onFilter={rs.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));

  expect(screen.getByRole('button', { name: inboundChip })).toBeInTheDocument();
  expect(screen.getByText(/server\.logging\.enabled/u)).toBeInTheDocument();
});

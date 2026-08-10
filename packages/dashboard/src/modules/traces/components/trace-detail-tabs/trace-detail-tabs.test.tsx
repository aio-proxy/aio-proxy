import type { DashboardTraceDetail } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TraceDetailTabs } from './trace-detail-tabs';

const detail: DashboardTraceDetail = {
  trace: {
    traceId: 'a'.repeat(32),
    rootSpanId: 'b'.repeat(16),
    requestId: 'request-a',
    startedAt: '2026-07-12T08:00:00.000Z',
    endedAt: '2026-07-12T08:00:00.125Z',
    durationMs: 125,
    otelStatusCode: 'OK',
    inboundProtocol: 'openai-response',
  },
  spans: [],
  diagnostics: {
    request: { protocol: 'openai-response', method: 'POST' },
  },
};

test('defaults to Detail and exposes request and response tab values', () => {
  render(<TraceDetailTabs detail={detail} selectedSpan={undefined} onSpanSelect={rs.fn()} />);

  expect(screen.getByRole('tab', { name: /^Detail$|^详情$/u })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/^Spans$|^Span$/u)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));
  expect(screen.getByRole('tab', { name: /^Request$|^请求$/u })).toHaveAttribute('aria-selected', 'true');

  fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));
  expect(screen.getByRole('tab', { name: /^Response$|^响应$/u })).toHaveAttribute('aria-selected', 'true');
});

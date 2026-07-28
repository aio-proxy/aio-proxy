import type { DashboardTraceSpan } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { SpanDetailPanel } from './span-detail-panel';

const span: DashboardTraceSpan = {
  traceId: 'a'.repeat(32),
  spanId: 'c'.repeat(16),
  parentSpanId: 'b'.repeat(16),
  name: 'aio_proxy.provider.attempt',
  kind: 'CLIENT',
  startedAt: '2026-07-12T08:00:00.010Z',
  endedAt: '2026-07-12T08:00:00.090Z',
  durationMs: 80,
  otelStatusCode: 'ERROR',
  terminationReason: 'failure',
  errorType: 'upstream_error',
  errorCode: 'provider_unavailable',
  attributes: { 'aio_proxy.provider.id': 'provider-a' },
  events: [
    {
      name: 'provider.failure',
      timestamp: '2026-07-12T08:00:00.080Z',
      attributes: { attempt: 1 },
    },
  ],
  links: [
    {
      traceId: 'd'.repeat(32),
      spanId: 'e'.repeat(16),
      attributes: { relationship: 'retry' },
    },
  ],
};

test('shows the selected Span identity, status, attributes, events, and links', () => {
  render(<SpanDetailPanel span={span} />);

  const panel = screen.getByTestId('span-detail-panel');
  expect(within(panel).getByText(span.name)).toBeTruthy();
  expect(within(panel).getByText(span.traceId)).toBeTruthy();
  expect(within(panel).getByText(span.spanId)).toBeTruthy();
  expect(within(panel).getByText(span.parentSpanId!)).toBeTruthy();
  expect(within(panel).getByText(/Failure|失败/u)).toBeTruthy();
  expect(within(panel).getByText(/Result details|结果详情/u)).toBeTruthy();
  expect(within(panel).getByText('upstream_error · provider_unavailable')).toBeTruthy();
  expect(within(panel).queryByText(/Error type|错误类型/u)).toBeNull();
  expect(within(panel).queryByText(/Error code|错误码/u)).toBeNull();
  expect(within(panel).getByText(/provider-a/u)).toBeTruthy();

  fireEvent.click(within(panel).getByRole('tab', { name: /Events|事件/u }));
  expect(within(panel).getByText('provider.failure')).toBeTruthy();
  expect(within(panel).getByText(/"attempt": 1/u)).toBeTruthy();

  fireEvent.click(within(panel).getByRole('tab', { name: /Links|链接/u }));
  expect(within(panel).getByText('d'.repeat(32))).toBeTruthy();
  expect(within(panel).getByText('e'.repeat(16))).toBeTruthy();
  expect(within(panel).getByText(/"relationship": "retry"/u)).toBeTruthy();
});

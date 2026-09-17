import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { SpanDetailPanel } from './span-detail-panel';

const trace: DashboardTraceSummary = {
  traceId: 'a'.repeat(32),
  rootSpanId: 'b'.repeat(16),
  requestId: 'request-a',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:00.125Z',
  durationMs: 125,
  otelStatusCode: 'ERROR',
  inboundProtocol: 'anthropic-messages',
  requestedModelId: 'claude-sonnet-4-6',
  finalModelId: 'claude-sonnet-4-6-20260101',
  finalHttpStatus: 500,
};

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
  attributes: {
    'aio_proxy.provider.id': 'provider-a',
    'http.status_code': 503,
    'aio_proxy.response.upstream_headers_ms': 40,
    'gen_ai.usage.input_tokens': 8412,
  },
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
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} />);

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

  fireEvent.click(within(panel).getByRole('tab', { name: /Events|事件/u }));
  expect(within(panel).getByText('provider.failure')).toBeTruthy();
  expect(within(panel).getByText(/"attempt": 1/u)).toBeTruthy();

  fireEvent.click(within(panel).getByRole('tab', { name: /Links|链接/u }));
  expect(within(panel).getByText('d'.repeat(32))).toBeTruthy();
  expect(within(panel).getByText('e'.repeat(16))).toBeTruthy();
  expect(within(panel).getByText(/"relationship": "retry"/u)).toBeTruthy();
});

test('dumps the raw attributes in the attributes tab', () => {
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} />);

  // Scoped to the tab panel: the provider ID also shows up in the status row above it.
  const attributes = within(screen.getByTestId('span-detail-panel')).getByRole('tabpanel');
  expect(within(attributes).getByText(/"aio_proxy\.provider\.id": "provider-a"/u)).toBeTruthy();
});

test('shows the OTel status when the selected Span records no HTTP status of its own', () => {
  const parse: DashboardTraceSpan = {
    traceId: trace.traceId,
    spanId: '1'.repeat(16),
    parentSpanId: trace.rootSpanId,
    name: 'aio_proxy.request.parse',
    kind: 'INTERNAL',
    startedAt: '2026-07-12T08:00:00.001Z',
    endedAt: '2026-07-12T08:00:00.004Z',
    durationMs: 3,
    otelStatusCode: 'UNSET',
    attributes: {},
    events: [],
    links: [],
  };

  render(<SpanDetailPanel span={parse} trace={trace} spans={[span, parse]} />);

  const row = within(screen.getByTestId('span-detail-panel')).getByTestId('span-status-row');
  // The trace ended 500, but this span never recorded a status code, so it must not claim one.
  expect(within(row).queryByText('500')).toBeNull();
  expect(within(row).getByText(/Success|成功/u)).toBeTruthy();
});

test('heads the panel with the failing HTTP status and the provider · model identity', () => {
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} />);

  const row = within(screen.getByTestId('span-detail-panel')).getByTestId('span-status-row');
  expect(within(row).getByText('503')).toHaveClass('text-destructive');
  expect(within(row).getByText('provider-a · claude-sonnet-4-6-20260101')).toBeTruthy();
});

test('keeps all six metric cells, filling missing values with the placeholder', () => {
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} />);

  const grid = within(screen.getByTestId('span-detail-panel')).getByTestId('span-metric-grid');
  const values = Array.from(grid.querySelectorAll('dd')).map((cell) => cell.textContent);

  expect(values).toEqual(['80 ms', '—', '40 ms', '8,412', '—', '1']);
});

test('renders the placeholder when no Span is selected', () => {
  render(<SpanDetailPanel span={undefined} trace={trace} spans={[]} />);

  const panel = screen.getByTestId('span-detail-panel');
  expect(within(panel).queryByTestId('span-metric-grid')).toBeNull();
  expect(within(panel).getByText('—')).toBeTruthy();
});

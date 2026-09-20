import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
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
    'http.response.status_code': 503,
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

test('shows the selected Span identity, status, result details, and its incoming links', () => {
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} onFilter={rs.fn()} />);

  const panel = screen.getByTestId('span-detail-panel');
  expect(within(panel).getByText(span.name)).toBeTruthy();
  expect(within(panel).getByText('upstream_error · provider_unavailable')).toBeTruthy();
  expect(within(panel).queryByText(/Error type|错误类型/u)).toBeNull();
  expect(within(panel).queryByText(/Error code|错误码/u)).toBeNull();

  // Span events are never recorded, so the panel has no events block at all; links are.
  const links = within(panel).getByTestId('span-link-list');
  expect(within(links).getByText(/e{16}/u)).toBeTruthy();
  expect(within(links).getByText(/"relationship": "retry"/u)).toBeTruthy();
  expect(within(panel).queryByText('provider.failure')).toBeNull();
});

test('leaves out the links block when the Span has none', () => {
  render(<SpanDetailPanel span={{ ...span, links: [] }} trace={trace} spans={[span]} onFilter={rs.fn()} />);

  expect(screen.queryByTestId('span-link-list')).toBeNull();
});

test('lists attributes as searchable rows, and turns one into a list filter', () => {
  const onFilter = rs.fn();
  // The status filter is whole-trace, so it is offered on the root span only; the attempt-span
  // direction is pinned in `lib/span-attribute-rows`.
  const root: DashboardTraceSpan = { ...span, spanId: trace.rootSpanId };
  render(<SpanDetailPanel span={root} trace={trace} spans={[root]} onFilter={onFilter} />);

  const table = screen.getByTestId('span-attribute-table');
  expect(within(table).getByText('aio_proxy.provider.id')).toBeTruthy();
  expect(within(table).getByText('503')).toBeTruthy();

  fireEvent.change(within(table).getByTestId('span-attribute-search'), { target: { value: 'status' } });
  expect(within(table).queryByText('aio_proxy.provider.id')).toBeNull();

  // The menu content renders in a portal, so it is queried off `screen`, not the table.
  fireEvent.click(within(table).getByRole('button', { name: /Attribute actions|属性操作/u }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Add as filter|加为筛选条件/u }));
  expect(onFilter).toHaveBeenCalledWith({ finalHttpStatus: 503 });
});

test('withholds the whole-trace filter when the selected Span is not the root', () => {
  // `span` is an attempt span, so its 503 is this hop's status, not the trace's — the same 503 the
  // test above offers as a filter on the root. Which keys are gated is pinned in
  // `lib/span-attribute-rows`; what this pins is that the panel tells it which span it is looking at.
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} onFilter={rs.fn()} />);

  const table = screen.getByTestId('span-attribute-table');
  fireEvent.change(within(table).getByTestId('span-attribute-search'), { target: { value: 'status' } });
  fireEvent.click(within(table).getByRole('button', { name: /Attribute actions|属性操作/u }));

  expect(screen.getByRole('menuitem', { name: /Copy value|复制值/u })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: /Add as filter|加为筛选条件/u })).toBeNull();
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

  render(<SpanDetailPanel span={parse} trace={trace} spans={[span, parse]} onFilter={rs.fn()} />);

  const row = within(screen.getByTestId('span-detail-panel')).getByTestId('span-status-row');
  // The trace ended 500, but this span never recorded a status code, so it must not claim one.
  expect(within(row).queryByText('500')).toBeNull();
  expect(within(row).getByText(/Success|成功/u)).toBeTruthy();
});

test('heads the panel with the failing HTTP status and the provider · model identity', () => {
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} onFilter={rs.fn()} />);

  const row = within(screen.getByTestId('span-detail-panel')).getByTestId('span-status-row');
  expect(within(row).getByText('503')).toHaveClass('text-destructive');
  expect(within(row).getByText('provider-a · claude-sonnet-4-6-20260101')).toBeTruthy();
});

test('keeps all six metric cells, filling missing values with the placeholder', () => {
  render(<SpanDetailPanel span={span} trace={trace} spans={[span]} onFilter={rs.fn()} />);

  const grid = within(screen.getByTestId('span-detail-panel')).getByTestId('span-metric-grid');
  const values = Array.from(grid.querySelectorAll('dd')).map((cell) => cell.textContent);

  expect(values).toEqual(['80 ms', '—', '40 ms', '8,412', '—', '1']);
});

// attempt 内隐藏重试时服务端不写 TTFT，格子会退回 `—`，和「没测到」长得一样。
test('explains an unattributable TTFT instead of showing the missing-value placeholder', () => {
  const ambiguous: DashboardTraceSpan = {
    ...span,
    attributes: { ...span.attributes, 'aio_proxy.response.transport_observation': 'ambiguous' },
  };
  const ttftCell = (subject: DashboardTraceSpan) => {
    const { unmount } = render(<SpanDetailPanel span={subject} trace={trace} spans={[subject]} onFilter={rs.fn()} />);
    const grid = within(screen.getByTestId('span-detail-panel')).getByTestId('span-metric-grid');
    const value = Array.from(grid.querySelectorAll('dd'))[1]?.textContent;
    unmount();
    return value;
  };

  expect(ttftCell(ambiguous)).toBe(m['dashboard.traces.span_metric_ttft_ambiguous']());

  // 老数据在 ambiguous 时也写过 TTFT。有数就显示数：解释只替换那个 `—`，不盖掉测到的值。
  expect(ttftCell({ ...ambiguous, attributes: { ...ambiguous.attributes, 'aio_proxy.attempt.ttft_ms': 30 } })).toBe(
    '30 ms',
  );
});

test('renders the placeholder when no Span is selected', () => {
  render(<SpanDetailPanel span={undefined} trace={trace} spans={[]} onFilter={rs.fn()} />);

  const panel = screen.getByTestId('span-detail-panel');
  expect(within(panel).queryByTestId('span-metric-grid')).toBeNull();
  expect(within(panel).getByText('—')).toBeTruthy();
});

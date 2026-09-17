import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { formatDuration } from '@/lib/format-duration';

import { SpanWaterfall } from './span-waterfall';

const traceId = 'a'.repeat(32);
const rootSpanId = 'b'.repeat(16);
const childSpanId = 'c'.repeat(16);
const spans: readonly DashboardTraceSpan[] = [
  {
    traceId,
    spanId: rootSpanId,
    name: 'aio_proxy.request',
    kind: 'SERVER',
    startedAt: '2026-07-12T08:00:00.000Z',
    endedAt: '2026-07-12T08:00:00.100Z',
    durationMs: 100,
    otelStatusCode: 'OK',
    attributes: {},
    events: [],
    links: [],
  },
  {
    traceId,
    spanId: childSpanId,
    parentSpanId: rootSpanId,
    name: 'aio_proxy.provider.attempt',
    kind: 'CLIENT',
    startedAt: '2026-07-12T08:00:00.010Z',
    endedAt: '2026-07-12T08:00:00.090Z',
    durationMs: 80,
    otelStatusCode: 'ERROR',
    attributes: {},
    events: [],
    links: [],
  },
];

test('keeps server order and selects Span rows through native button activation', () => {
  const onSelect = rs.fn();
  render(
    <SpanWaterfall
      spans={spans}
      selectedSpanId={rootSpanId}
      now={new Date('2026-07-12T08:00:00.100Z')}
      onSelect={onSelect}
    />,
  );

  expect(screen.getAllByTestId('trace-span').map((row) => row.textContent)).toEqual([
    expect.stringContaining('aio_proxy.request'),
    expect.stringContaining('aio_proxy.provider.attempt'),
  ]);
  expect(screen.getByRole('button', { name: /aio_proxy\.request/u })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: /aio_proxy\.provider\.attempt/u }));
  fireEvent.click(screen.getByRole('button', { name: /aio_proxy\.request/u }));

  expect(onSelect).toHaveBeenNthCalledWith(1, childSpanId);
  expect(onSelect).toHaveBeenNthCalledWith(2, rootSpanId);
});

test('filters rows by span name and falls back to an empty message', () => {
  render(
    <SpanWaterfall
      spans={spans}
      selectedSpanId={rootSpanId}
      now={new Date('2026-07-12T08:00:00.100Z')}
      onSelect={rs.fn()}
    />,
  );

  const search = screen.getByTestId('span-search');
  fireEvent.change(search, { target: { value: '  ATTEMPT ' } });

  expect(screen.getAllByTestId('trace-span').map((row) => row.textContent)).toEqual([
    expect.stringContaining('aio_proxy.provider.attempt'),
  ]);

  fireEvent.change(search, { target: { value: 'nothing-matches' } });

  expect(screen.queryAllByTestId('trace-span')).toEqual([]);
  expect(screen.getByText(m['dashboard.traces.span_search_empty']())).toBeTruthy();
});

test('scales ruler ticks to the whole trace, not to the root Span duration', () => {
  const lateChild: DashboardTraceSpan = {
    ...spans[1]!,
    // Outlives the 100ms root Span, so the trace spans 160ms in total.
    endedAt: '2026-07-12T08:00:00.160Z',
    durationMs: 150,
  };

  render(
    <SpanWaterfall
      spans={[spans[0]!, lateChild]}
      selectedSpanId={rootSpanId}
      now={new Date('2026-07-12T08:00:00.160Z')}
      onSelect={rs.fn()}
    />,
  );

  expect(screen.getByTestId('waterfall-ruler').textContent).toBe(
    [0, 40, 80, 120, 160].map((ms) => formatDuration(ms)).join(''),
  );
});

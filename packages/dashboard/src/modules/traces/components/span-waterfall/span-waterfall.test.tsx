import type { DashboardTraceSpan } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

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

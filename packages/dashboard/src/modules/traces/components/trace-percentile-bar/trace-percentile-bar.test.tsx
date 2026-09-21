import type { DashboardTracePercentile } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TracePercentileBar } from './trace-percentile-bar';

const comparison: DashboardTracePercentile = {
  modelId: 'gpt-5',
  sampleCount: 42,
  durationMs: 800,
  percentile: 73,
  minMs: 200,
  maxMs: 1_000,
  p50Ms: 400,
  p95Ms: 900,
};

const leftOf = (element: Element | null) => (element as HTMLElement | null)?.style.left;

test('places the trace between the window ticks in proportion to its latency', () => {
  render(<TracePercentileBar comparison={comparison} />);

  const bar = screen.getByTestId('trace-percentile-bar');
  expect(bar.textContent).toContain('42');
  expect(bar.textContent).toContain('gpt-5');
  expect(bar.textContent).toContain('73');
  // (800 - 200) / (1000 - 200)
  expect(leftOf(screen.getByTestId('trace-percentile-marker'))).toBe('75%');
  expect(leftOf(screen.getByText('p50'))).toBe('25%');
  expect(leftOf(screen.getByText('p95'))).toBe('87.5%');
});

test('pins every marker to the left edge when the window has no spread', () => {
  const flat: DashboardTracePercentile = {
    ...comparison,
    durationMs: 500,
    minMs: 500,
    maxMs: 500,
    p50Ms: 500,
    p95Ms: 500,
  };
  render(<TracePercentileBar comparison={flat} />);

  expect(leftOf(screen.getByTestId('trace-percentile-marker'))).toBe('0%');
  expect(leftOf(screen.getByText('p95'))).toBe('0%');
});

test('renders nothing while the sample is short or the comparison has not arrived', () => {
  const { container } = render(<TracePercentileBar comparison={null} />);
  expect(container.innerHTML).toBe('');

  const pending = render(<TracePercentileBar comparison={undefined} />);
  expect(pending.container.innerHTML).toBe('');
});

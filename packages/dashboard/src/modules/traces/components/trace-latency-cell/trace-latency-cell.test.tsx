import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceLatencyCell } from './trace-latency-cell';

test('aligns duration and TTFT while marking only present values', () => {
  const view = render(<TraceLatencyCell durationMs={125} stream ttftMs={42} />);

  expect(screen.getByText(/125/u)).toBeTruthy();
  expect(screen.getByText(/TTFT.*42/u)).toBeTruthy();
  expect(view.container.querySelectorAll('[data-latency-dot]')).toHaveLength(2);
  expect(view.container.querySelector('[data-fast-marker]')).toBeNull();

  view.rerender(<TraceLatencyCell durationMs={250} stream />);
  expect(screen.getByText(/TTFT.*—/u)).toBeTruthy();
  expect(view.container.querySelectorAll('[data-latency-dot]')).toHaveLength(1);
});

test('marks fast-mode requests independently of duration', () => {
  const view = render(<TraceLatencyCell durationMs={5_000} fast />);

  expect(view.container.querySelector('[data-fast-marker]')).toBeTruthy();

  view.rerender(<TraceLatencyCell durationMs={125} />);
  expect(view.container.querySelector('[data-fast-marker]')).toBeNull();
});

test('colors duration from throughput when output tokens are large enough', () => {
  const view = render(<TraceLatencyCell durationMs={8_000} outputTokens={240} />);
  const durationDot = view.container.querySelector('[data-latency-dot]');

  expect(durationDot).toHaveClass('bg-primary');
  expect(durationDot).not.toHaveClass('bg-destructive');

  view.rerender(<TraceLatencyCell durationMs={8_000} outputTokens={100} />);
  expect(view.container.querySelector('[data-latency-dot]')).toHaveClass('bg-destructive');
});

import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceLatencyCell } from './trace-latency-cell';

test('aligns duration and TTFT while marking only present values', () => {
  const view = render(<TraceLatencyCell durationMs={125} stream ttftMs={42} />);

  expect(screen.getByText(/125/u)).toBeTruthy();
  expect(screen.getByText(/TTFT.*42/u)).toBeTruthy();
  expect(view.container.querySelectorAll('[data-latency-dot]')).toHaveLength(2);
  expect(view.container.querySelector('[data-fast-marker]')).toBeTruthy();

  view.rerender(<TraceLatencyCell durationMs={250} stream />);
  expect(screen.getByText(/TTFT.*—/u)).toBeTruthy();
  expect(view.container.querySelectorAll('[data-latency-dot]')).toHaveLength(1);
});

import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceTokenCell } from './trace-token-cell';

test('shows directional and cache token values without inventing missing usage', () => {
  const view = render(
    <TraceTokenCell usage={{ inputTokens: 26_600, outputTokens: 318, cacheReadTokens: 1_024, cacheWriteTokens: 64 }} />,
  );

  expect(screen.getByText('26.6K')).toBeTruthy();
  expect(screen.getByText('318')).toBeTruthy();
  expect(screen.getByText('1K')).toBeTruthy();
  expect(screen.getByText('64')).toBeTruthy();

  view.rerender(<TraceTokenCell />);
  expect(screen.getByText('—')).toBeTruthy();
});

import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { RoutingHealthStrip } from './routing-health-strip';

const counts = { 'no-eligible': 3, 'single-point': 41, deviating: 7 } as const;

test('shows every count and marks the active filter pressed', () => {
  render(<RoutingHealthStrip total={217} counts={counts} active="no-eligible" onToggle={() => {}} />);

  expect(screen.getByText('217')).toBeInTheDocument();
  expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('3');
});

test('toggles the risk it was clicked with', () => {
  const onToggle = rs.fn();
  render(<RoutingHealthStrip total={1} counts={counts} active={undefined} onToggle={onToggle} />);

  screen.getByText('41').closest('button')?.click();

  expect(onToggle).toHaveBeenCalledWith('single-point');
});

test('never renders zero for an unmeasured deviation count', () => {
  // A traffic query that has not landed or has failed is unknown, not "no deviation".
  render(
    <RoutingHealthStrip
      total={1}
      counts={{ ...counts, deviating: undefined }}
      active={undefined}
      onToggle={() => {}}
    />,
  );

  expect(screen.queryByText('0')).not.toBeInTheDocument();
  expect(screen.getByText(/Measuring|统计中/u)).toBeInTheDocument();
});

test('does not let an unmeasured deviation tile be filtered by', () => {
  const onToggle = rs.fn();
  render(
    <RoutingHealthStrip
      total={1}
      counts={{ ...counts, deviating: undefined }}
      active={undefined}
      onToggle={onToggle}
    />,
  );

  screen
    .getByText(/Measuring|统计中/u)
    .closest('button')
    ?.click();

  expect(onToggle).not.toHaveBeenCalled();
});

test('leaves the total tile unclickable', () => {
  render(<RoutingHealthStrip total={217} counts={counts} active={undefined} onToggle={() => {}} />);

  // Three clickable risks, and the total is not one of them.
  expect(screen.getAllByRole('button')).toHaveLength(3);
});

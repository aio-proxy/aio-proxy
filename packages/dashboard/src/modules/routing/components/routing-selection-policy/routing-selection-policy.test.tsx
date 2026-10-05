import { m } from '@aio-proxy/i18n';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { RoutingSelectionPolicy } from './routing-selection-policy';

const mocks = rs.hoisted(() => ({ mutate: rs.fn(), isPending: false }));

rs.mock('../../hooks/use-routing-selection-mutation', () => ({
  useRoutingSelectionMutation: () => ({ mutate: mocks.mutate, isPending: mocks.isPending }),
}));

afterEach(() => {
  mocks.mutate.mockReset();
  mocks.isPending = false;
});

const toggle = () => screen.getByRole('switch', { name: m['dashboard.routing.selection_quota_reset']() });

test('shows the weighted draw as off and switches the policy on', () => {
  render(<RoutingSelectionPolicy selection="weighted" writable />);

  expect(toggle()).not.toBeChecked();
  fireEvent.click(toggle());
  expect(mocks.mutate).toHaveBeenCalledWith({ selection: 'quota-reset' }, expect.anything());
});

test('switches quota-reset back to the weighted draw', () => {
  render(<RoutingSelectionPolicy selection="quota-reset" writable />);

  expect(toggle()).toBeChecked();
  fireEvent.click(toggle());
  expect(mocks.mutate).toHaveBeenCalledWith({ selection: 'weighted' }, expect.anything());
});

test('cannot be changed when the config file is read-only', () => {
  render(<RoutingSelectionPolicy selection="weighted" writable={false} />);

  // Base UI renders the switch as a span, so disabled is carried by aria-disabled.
  expect(toggle()).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(toggle());
  expect(mocks.mutate).not.toHaveBeenCalled();
});

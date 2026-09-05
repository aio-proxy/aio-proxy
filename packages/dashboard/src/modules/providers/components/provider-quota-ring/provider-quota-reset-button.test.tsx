import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderQuotaResetButton } from './provider-quota-reset-button';
import { ProviderQuotaRing } from './provider-quota-ring';

const queryMocks = { data: undefined as unknown };
const resetMock = { calls: 0, pending: false };

rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: () => ({ data: queryMocks.data, isPending: false, isError: false }),
}));
rs.mock('../../hooks/use-provider-quota-refresh', () => ({
  useProviderQuotaRefresh: () => ({ mutate: () => {}, isPending: false }),
}));
rs.mock('../../hooks/use-provider-quota-reset', () => ({
  useProviderQuotaReset: () => ({
    mutate: () => {
      resetMock.calls += 1;
    },
    isPending: resetMock.pending,
  }),
}));

const provider = providerStub({ id: 'codex', name: 'Codex', hasQuota: true });

const snapshotWith = (resetCredits: unknown) => ({
  sampledAt: 1,
  stale: false,
  snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }], resetCredits },
});

const openDialog = () => {
  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));
};

// Redemption is irreversible and spends a scarce grant, so the button must not act on the first click.
test('redeeming asks for confirmation before spending the credit', () => {
  queryMocks.data = snapshotWith({ availableCount: 2 });
  resetMock.pending = false;
  const before = resetMock.calls;

  openDialog();
  fireEvent.click(screen.getByTestId('provider-quota-reset'));

  expect(screen.getByTestId('provider-quota-reset-confirm-inline')).toBeInTheDocument();
  expect(resetMock.calls).toBe(before);

  fireEvent.click(screen.getByTestId('provider-quota-reset-confirm'));
  expect(resetMock.calls).toBe(before + 1);
});

/**
 * The confirmation is inline rather than a nested popup: this button lives inside the quota modal, so a
 * second frame would cover the very reading the decision is made from. Asserting the quota dialog is
 * still readable is what keeps a future refactor from reaching for `AlertDialog` again.
 */
test('confirming does not cover the quota reading it is decided from', () => {
  queryMocks.data = snapshotWith({ availableCount: 2 });
  resetMock.pending = false;

  openDialog();
  fireEvent.click(screen.getByTestId('provider-quota-reset'));

  expect(screen.getByTestId('provider-quota-dialog')).toBeInTheDocument();
  expect(screen.getByTestId('provider-quota-refresh')).toBeInTheDocument();
});

// A redemption takes seconds against upstream. With no in-place progress the popup looks inert and
// invites a second click, which is why the trigger is replaced rather than merely disabled.
test('an in-flight redemption reports itself where the button was', () => {
  queryMocks.data = snapshotWith({ availableCount: 2 });
  resetMock.pending = true;

  openDialog();

  expect(screen.getByTestId('provider-quota-reset-pending')).toBeInTheDocument();
  expect(screen.queryByTestId('provider-quota-reset')).not.toBeInTheDocument();
  expect(screen.queryByTestId('provider-quota-reset-confirm')).not.toBeInTheDocument();
});

/**
 * Confirming unmounts the button the keyboard user activated, so without an explicit hand-off focus sits
 * on the document body for the seconds the request and its refetch take, and the returning trigger comes
 * back unfocused. React does not reuse the node across either swap — hence the focusable disabled control
 * and the effect that moves focus on each mount.
 */
test('focus follows the redemption from the confirmation through progress back to the trigger', () => {
  resetMock.pending = false;

  const view = render(<ProviderQuotaResetButton providerId="codex" availableCount={2} />);
  fireEvent.click(screen.getByTestId('provider-quota-reset'));
  fireEvent.click(screen.getByTestId('provider-quota-reset-confirm'));

  resetMock.pending = true;
  view.rerender(<ProviderQuotaResetButton providerId="codex" availableCount={2} />);

  const pending = screen.getByTestId('provider-quota-reset-pending');
  // Base UI keeps a `focusableWhenDisabled` button in the tab order, so it reports `aria-disabled`
  // rather than the native attribute that would make it unfocusable.
  expect(pending).toHaveAttribute('aria-disabled', 'true');
  expect(pending).toHaveFocus();

  resetMock.pending = false;
  view.rerender(<ProviderQuotaResetButton providerId="codex" availableCount={2} />);

  expect(screen.getByTestId('provider-quota-reset')).toHaveFocus();
});

/**
 * The hand-off is scoped to the redemption this component started. A popup reopened while somebody
 * else's redemption is still in flight must not steal focus from wherever the user actually is.
 */
test('a redemption started elsewhere does not steal focus', () => {
  resetMock.pending = true;

  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();

  render(<ProviderQuotaResetButton providerId="codex" availableCount={2} />);

  expect(screen.getByTestId('provider-quota-reset-pending')).toBeInTheDocument();
  expect(outside).toHaveFocus();

  outside.remove();
});

/**
 * Without an enclosing dialog nothing announces the prompt on its own, and focus lands on Cancel the
 * moment the trigger unmounts. A screen reader must still get the count and the irreversibility from
 * whichever control is focused, the way `AlertDialogDescription` used to supply it.
 */
test('the confirmation describes its consequence to whichever control is focused', () => {
  queryMocks.data = snapshotWith({ availableCount: 2 });
  resetMock.pending = false;

  openDialog();
  fireEvent.click(screen.getByTestId('provider-quota-reset'));

  const consequence = /2/;

  expect(document.activeElement).toHaveAccessibleDescription(consequence);
  expect(screen.getByTestId('provider-quota-reset-confirm')).toHaveAccessibleDescription(consequence);
});

// The count is the whole gate: a control that could only ever fail is worse than no control.
test('an exhausted inventory reports the count without offering redemption', () => {
  queryMocks.data = snapshotWith({ availableCount: 0 });
  resetMock.pending = false;

  openDialog();

  expect(screen.queryByTestId('provider-quota-reset')).not.toBeInTheDocument();
});

test('an upstream that reports no inventory at all offers nothing to redeem', () => {
  queryMocks.data = snapshotWith(undefined);
  resetMock.pending = false;

  openDialog();

  expect(screen.queryByTestId('provider-quota-reset')).not.toBeInTheDocument();
});

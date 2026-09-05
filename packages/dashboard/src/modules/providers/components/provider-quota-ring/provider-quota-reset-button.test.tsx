import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
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

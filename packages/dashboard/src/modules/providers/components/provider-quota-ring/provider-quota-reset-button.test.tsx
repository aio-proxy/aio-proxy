import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderQuotaDialog } from './provider-quota-dialog';
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

// The popup rendered directly, so a rerender can publish a new count into the subtree the way the
// post-redemption refetch does. Going through `ProviderQuotaRing` would not: its snapshot comes from the
// mocked `useQuery`, which a rerender does not re-read.
const QuotaDialog: React.FC<{ readonly result: ReturnType<typeof snapshotWith> }> = ({ result }) => (
  <ProviderQuotaDialog
    provider={provider}
    pluginLabel={undefined}
    pluginIcon={undefined}
    open
    onOpenChange={() => {}}
    result={result as never}
    onRefresh={() => {}}
    refreshing={false}
  />
);

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
 * on the document body for the seconds the request and its refetch take. The trigger and the progress
 * control share one `slotRef` position, so a single hand-off has to carry the whole wait and survive the
 * return — hence the focusable disabled control rather than an inert span.
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
 * Cancelling unmounts the auto-focused Cancel button, so the trigger has to be handed focus back the way
 * the `AlertDialog` this replaced used to return it. Nothing about the redemption is involved, which is
 * why the hand-off cannot be keyed on the mutation.
 */
test('cancelling returns focus to the trigger', () => {
  resetMock.pending = false;

  render(<ProviderQuotaResetButton providerId="codex" availableCount={2} />);
  fireEvent.click(screen.getByTestId('provider-quota-reset'));
  fireEvent.click(screen.getByTestId('provider-quota-reset-cancel'));

  expect(screen.getByTestId('provider-quota-reset')).toHaveFocus();
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

/**
 * The redemption outlives the count it was started from: the invalidation it returns publishes
 * `availableCount: 0` while the request is still in flight. A caller-side `availableCount > 0` gate
 * therefore unmounted the spinner mid-request and dropped focus to the page — the dead click this whole
 * control exists to remove. Driven through the popup because that is where the count arrives.
 */
test('spending the last credit keeps the progress visible until the request settles', () => {
  resetMock.pending = false;

  const view = render(<QuotaDialog result={snapshotWith({ availableCount: 1 })} />);
  fireEvent.click(screen.getByTestId('provider-quota-reset'));
  fireEvent.click(screen.getByTestId('provider-quota-reset-confirm'));

  // What the post-redemption refetch publishes while the mutation is still pending.
  resetMock.pending = true;
  view.rerender(<QuotaDialog result={snapshotWith({ availableCount: 0 })} />);

  const pending = screen.getByTestId('provider-quota-reset-pending');
  expect(pending).toBeInTheDocument();
  expect(pending).toHaveFocus();

  resetMock.pending = false;
  view.rerender(<QuotaDialog result={snapshotWith({ availableCount: 0 })} />);

  // Nothing left to spend, so no control — but focus must land somewhere inside the popup rather than
  // on the document body, which would strand a keyboard user outside the frame they are still reading.
  expect(screen.queryByTestId('provider-quota-reset-pending')).not.toBeInTheDocument();
  expect(screen.queryByTestId('provider-quota-reset')).not.toBeInTheDocument();
  expect(screen.getByTestId('provider-quota-dialog')).toHaveFocus();
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

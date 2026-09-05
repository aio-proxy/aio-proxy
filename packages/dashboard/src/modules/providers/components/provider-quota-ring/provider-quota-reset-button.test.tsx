import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderQuotaRing } from './provider-quota-ring';

const queryMocks = { data: undefined as unknown };
const resetMock = { calls: 0 };

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
    isPending: false,
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
  const before = resetMock.calls;

  openDialog();
  fireEvent.click(screen.getByTestId('provider-quota-reset'));

  expect(screen.getByTestId('provider-quota-reset-dialog')).toBeInTheDocument();
  expect(resetMock.calls).toBe(before);

  fireEvent.click(screen.getByTestId('provider-quota-reset-confirm'));
  expect(resetMock.calls).toBe(before + 1);
});

// The count is the whole gate: a control that could only ever fail is worse than no control.
test('an exhausted inventory reports the count without offering redemption', () => {
  queryMocks.data = snapshotWith({ availableCount: 0 });

  openDialog();

  expect(screen.queryByTestId('provider-quota-reset')).not.toBeInTheDocument();
});

test('an upstream that reports no inventory at all offers nothing to redeem', () => {
  queryMocks.data = snapshotWith(undefined);

  openDialog();

  expect(screen.queryByTestId('provider-quota-reset')).not.toBeInTheDocument();
});

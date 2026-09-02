import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderQuotaRing } from './provider-quota-ring';

const queryMocks = { data: undefined as unknown, isPending: false, isError: false };
const refreshMock = { calls: 0 };

rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: () => ({ data: queryMocks.data, isPending: queryMocks.isPending, isError: queryMocks.isError }),
}));
rs.mock('../../hooks/use-provider-quota-refresh', () => ({
  useProviderQuotaRefresh: () => ({
    mutate: () => {
      refreshMock.calls += 1;
    },
    isPending: false,
  }),
}));

const provider = providerStub({ id: 'kimi', name: 'Kimi', hasQuota: true });

test('renders the tightest remaining percentage on the ring', () => {
  queryMocks.data = {
    sampledAt: 1_700_000_000_000,
    stale: false,
    snapshot: {
      items: [
        { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8 },
        { id: 'five-hour', displayName: 'Five hour', remainingRatio: 0.12 },
      ],
    },
  };

  render(<ProviderQuotaRing provider={provider} />);

  expect(screen.getByTestId('provider-quota-ring')).toHaveTextContent('12');
});

test('opening the ring lists the windows with a remaining amount, hides the rest, and refreshes', () => {
  queryMocks.data = {
    sampledAt: 1_700_000_000_000,
    stale: false,
    snapshot: {
      items: [
        { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8 },
        { id: 'unrated', displayName: 'Unrated' },
      ],
    },
  };
  const before = refreshMock.calls;

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByText('Weekly')).toBeInTheDocument();
  // Nothing to report is nothing to render: the row would only have said it had no number.
  expect(screen.queryByText('Unrated')).not.toBeInTheDocument();
  expect(screen.queryByTestId('provider-quota-item-unrated')).not.toBeInTheDocument();
  expect(refreshMock.calls).toBe(before + 1);
});

test('a snapshot where no window reports a remaining amount says so instead of listing nothing', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'unrated', displayName: 'Unrated' }] },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByTestId('provider-quota-empty')).toBeInTheDocument();
});

test('the footer refresh button asks for another reading', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));
  const before = refreshMock.calls;
  fireEvent.click(screen.getByTestId('provider-quota-refresh'));

  expect(refreshMock.calls).toBe(before + 1);
});

test('the arc is drawn from the raw ratio, not the floored display percent', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.004 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);

  // The label floors to 1% so it never reads "0%", but the arc must stay ~invisible.
  expect(screen.getByTestId('provider-quota-ring')).toHaveTextContent('1');
  const arc = screen.getByTestId('provider-quota-arc');
  const circumference = Number(arc.getAttribute('stroke-dasharray'));
  expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.996, 5);
});

test('a tiny non-zero remainder never reads as zero in the dialog', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.004 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByTestId('provider-quota-item-weekly')).toHaveTextContent(/<1%|Less than 1%|不足 1%/u);
  // The bar carries the raw ratio, so its own value is 0. A screen reader reads `aria-valuetext`, not
  // the `aria-hidden` value span, and must not be told the quota is empty when it is not.
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuetext',
    expect.stringMatching(/<1%|Less than 1%|不足 1%/u),
  );
});

test('a stale reading is called out in the dialog', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: true,
    error: 'OAUTH_QUOTA_READ_FAILED',
    snapshot: { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }] },
  };

  render(<ProviderQuotaRing provider={provider} />);
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(screen.getByTestId('provider-quota-stale')).toBeInTheDocument();
});

test('a failed first read stays recoverable: the indicator is a button that retries', () => {
  queryMocks.data = undefined;
  queryMocks.isError = true;
  try {
    render(<ProviderQuotaRing provider={provider} />);

    const unavailable = screen.getByTestId('provider-quota-unavailable');
    expect(unavailable.tagName).toBe('BUTTON');

    const before = refreshMock.calls;
    fireEvent.click(unavailable);
    expect(refreshMock.calls).toBe(before + 1);
    expect(screen.getByTestId('provider-quota-dialog')).toBeInTheDocument();
    // The dialog's own refresh control is the only way out of a failed read, so it has to render
    // even though there is no snapshot to describe.
    expect(screen.getByTestId('provider-quota-refresh')).toBeInTheDocument();
  } finally {
    queryMocks.isError = false;
  }
});

test('clicking the ring does not bubble to the card', () => {
  queryMocks.data = {
    sampledAt: 1,
    stale: false,
    snapshot: { items: [{ id: 'w', displayName: 'W', remainingRatio: 0.5 }] },
  };
  const onCardClick = rs.fn();

  render(
    <div onClick={onCardClick} role="presentation">
      <ProviderQuotaRing provider={provider} />
    </div>,
  );
  fireEvent.click(screen.getByTestId('provider-quota-ring'));

  expect(onCardClick).not.toHaveBeenCalled();
});

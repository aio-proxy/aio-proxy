import { ProviderKind } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderCardGrid } from './provider-card-grid';

// `Link` survives because ProviderMoreMenu and the card identity both render one; `useNavigate` does
// not, because no component in the grid navigates programmatically any more.
rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));
rs.mock('../../hooks/use-provider-enabled-mutation', () => ({
  useProviderEnabledMutation: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderDelete: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../../hooks/use-provider-credential-refresh', () => ({
  useProviderCredentialRefresh: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../provider-quota-ring', () => ({ ProviderQuotaRing: () => null }));
// The grid's own three queries all hand back lookup maps; the card's per-Provider quota query is a
// different shape, so the mock has to tell them apart rather than return one value for everything.
rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly unknown[] }) =>
    options.queryKey[2] === 'quota'
      ? { data: undefined, isPending: false, isError: true }
      : { data: new Map(), isPending: false, isError: false },
}));

const providers = [
  providerStub({ id: 'alpha', name: 'Alpha', kind: ProviderKind.Api, priority: 1 }),
  providerStub({ id: 'beta', name: 'Beta', kind: ProviderKind.OAuth, priority: 9, enabled: false }),
];

test('renders one card per Provider, sorted by priority', () => {
  render(<ProviderCardGrid providers={providers} />);

  const cards = screen.getAllByTestId(/^provider-row-/u);
  expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual(['provider-row-beta', 'provider-row-alpha']);
});

test('the search box is a labelled field that narrows the grid and reports an empty result', () => {
  render(<ProviderCardGrid providers={providers} />);

  // A nameless textbox is unusable with a screen reader, so the accessible name is part of the contract.
  const search = screen.getByTestId('provider-search');
  expect(search).toHaveAccessibleName();

  fireEvent.change(search, { target: { value: 'alpha' } });
  expect(screen.queryByTestId('provider-row-beta')).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: 'nothing' } });
  expect(screen.getByTestId('providers-no-matches')).toBeInTheDocument();
});

test('a chip filters by enablement and reports its pressed state', () => {
  render(<ProviderCardGrid providers={providers} />);

  const disabled = screen.getByTestId('provider-filter-enablement-disabled');
  expect(disabled).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(disabled);

  expect(disabled).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('provider-filter-enablement-all')).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByTestId('provider-row-beta')).toBeInTheDocument();
  expect(screen.queryByTestId('provider-row-alpha')).not.toBeInTheDocument();
});

test('each chip group is named for assistive technology', () => {
  const { container } = render(<ProviderCardGrid providers={providers} />);

  // The shadcn `Field` wrapper around the search box is also a `group`, so scope this to the chips.
  const groups = [...container.querySelectorAll('[role="group"]')].filter((group) =>
    group.querySelector('[data-testid^="provider-filter-"]'),
  );
  expect(groups.length).toBe(3);
  for (const group of groups) expect(group).toHaveAccessibleName();
});

test('marks the focused Provider', () => {
  render(<ProviderCardGrid providers={providers} focusProviderId="alpha" />);

  expect(screen.getByTestId('provider-row-alpha')).toHaveAttribute('data-focused', 'true');
});

test('deep-link focus does not fire again when the user filters', async () => {
  render(<ProviderCardGrid providers={providers} focusProviderId="alpha" />);
  await nextFrames();

  const search = screen.getByTestId('provider-search');
  search.focus();
  fireEvent.change(search, { target: { value: 'alpha' } });
  await nextFrames();

  // Re-focusing the card here would rip the cursor out of the box mid-word.
  expect(document.activeElement).toBe(search);
});

const nextFrames = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

test('a Provider the usage response omits counts as zero requests, not as unknown', () => {
  // The usage query above resolves to an empty map, which is exactly what the route returns once no
  // Provider saw traffic in the window. Rendering `N/A` there would read as "we could not tell",
  // when the server told us plainly: nobody called it.
  render(<ProviderCardGrid providers={providers} />);

  const card = screen.getByTestId('provider-row-alpha');
  expect(card.textContent).toMatch(/0\s*(次|件|회)?\s*\/ 24h/u);
  expect(card.textContent).not.toContain('N/A');
});

test('deep-link focus lands once the target Provider arrives on a later render', async () => {
  // A cached list served from `providersQueryOptions` need not contain a Provider the user just
  // created; the background refetch adds it. An effect keyed on the ID alone would have already run
  // and never retried, leaving the deep link with no scroll and no keyboard focus.
  const { rerender } = render(<ProviderCardGrid providers={providers} focusProviderId="gamma" />);
  await nextFrames();

  const grown = [...providers, providerStub({ id: 'gamma', name: 'Gamma', kind: ProviderKind.Api })];
  rerender(<ProviderCardGrid providers={grown} focusProviderId="gamma" />);
  await nextFrames();

  expect(document.activeElement).toBe(screen.getByTestId('provider-link-gamma'));
});

test('deep-link focus waits for a filter that hides the target to be cleared', async () => {
  // A filter narrowed before the double-rAF fires leaves the target card out of the document. Giving
  // up there would drop the deep link silently: the card comes back when the filter clears, but
  // nothing would scroll to it or move the keyboard there.
  render(<ProviderCardGrid providers={providers} focusProviderId="beta" />);
  const search = screen.getByTestId('provider-search');
  fireEvent.change(search, { target: { value: 'alpha' } });
  await nextFrames();
  expect(screen.queryByTestId('provider-link-beta')).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: '' } });
  await nextFrames();

  expect(document.activeElement).toBe(screen.getByTestId('provider-link-beta'));
});

test('renders the empty state when there are no Providers at all', () => {
  render(<ProviderCardGrid providers={[]} />);

  expect(screen.getByText(/No providers configured|未配置提供商/u)).toBeInTheDocument();
});

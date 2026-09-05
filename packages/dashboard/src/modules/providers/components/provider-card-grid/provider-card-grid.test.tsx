import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { queryKeys } from '@/lib/query-keys';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderCardGrid } from './provider-card-grid';

const routingMocks = rs.hoisted(() => ({ mutate: rs.fn() }));
const healthMocks = rs.hoisted(() => ({ unavailable: false }));

// `Link` survives because ProviderMoreMenu and the card identity both render one; `useNavigate` does
// not, because no component in the grid navigates programmatically any more.
rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));
rs.mock('../../hooks/use-provider-enabled-mutation', () => ({
  useProviderEnabledMutation: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderDelete: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../../hooks/use-provider-routing-mutation', () => ({
  useProviderRoutingMutation: () => ({ mutate: routingMocks.mutate, isPending: false }),
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
    options.queryKey[2] === 'quota' ||
    (healthMocks.unavailable && JSON.stringify(options.queryKey) === JSON.stringify(queryKeys.providerHealth))
      ? { data: undefined, isPending: false, isError: true }
      : { data: new Map(), isPending: false, isError: false },
}));

const providers = [
  providerStub({ id: 'alpha', name: 'Alpha', kind: ProviderKind.Api, priority: 1, clientModels: ['alpha-model'] }),
  providerStub({ id: 'beta', name: 'Beta', kind: ProviderKind.OAuth, priority: 9, enabled: false }),
];

afterEach(() => {
  routingMocks.mutate.mockReset();
  healthMocks.unavailable = false;
  Reflect.deleteProperty(document, 'getAnimations');
});

test('renders a flat card grid sorted by priority, then weight', () => {
  const weightedProviders = [
    ...providers,
    providerStub({ id: 'gamma', name: 'Gamma', kind: ProviderKind.Api, priority: 1, weight: 9 }),
  ];
  render(<ProviderCardGrid providers={weightedProviders} routingRevision="revision" />);

  const cards = screen.getAllByTestId(/^provider-row-/u);
  expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual([
    'provider-row-beta',
    'provider-row-gamma',
    'provider-row-alpha',
  ]);
  expect(screen.queryByTestId('provider-tier-1')).not.toBeInTheDocument();
});

test('the search box is a labelled field that narrows the grid and reports an empty result', () => {
  render(<ProviderCardGrid providers={providers} routingRevision="revision" />);

  // A nameless textbox is unusable with a screen reader, so the accessible name is part of the contract.
  const search = screen.getByTestId('provider-search');
  expect(search).toHaveAccessibleName();

  fireEvent.change(search, { target: { value: 'alpha' } });
  expect(screen.queryByTestId('provider-row-beta')).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: 'nothing' } });
  expect(screen.getByTestId('providers-no-matches')).toBeInTheDocument();
});

test('card tier and weight share match management and stay stable when peers are filtered out', () => {
  const allProviders = [
    providerStub({ id: 'primary', priority: 9 }),
    providerStub({ id: 'alpha', name: 'Alpha', priority: 1, weight: 3 }),
    providerStub({ id: 'beta', priority: 1, weight: 7, enabled: false }),
    providerStub({ id: 'broken', kind: 'invalid', priority: 99 }),
  ];
  const { rerender } = render(<ProviderCardGrid providers={allProviders} routingRevision="revision" />);
  const alpha = within(screen.getByTestId('provider-row-alpha'));
  expect(alpha.getByTestId('provider-card-route-tier')).toHaveTextContent(
    m['dashboard.providers.routing.tier']({ tier: 2 }),
  );
  expect(alpha.getByTestId('provider-card-route-share')).toHaveTextContent('30%');
  expect(within(screen.getByTestId('provider-row-broken')).queryByTestId('provider-card-routing')).toBeNull();

  fireEvent.click(screen.getByTestId('provider-filter-enablement-enabled'));
  fireEvent.change(screen.getByTestId('provider-search'), { target: { value: 'Alpha' } });
  expect(screen.getAllByTestId(/^provider-row-/u)).toHaveLength(1);
  expect(alpha.getByTestId('provider-card-route-tier')).toHaveTextContent(
    m['dashboard.providers.routing.tier']({ tier: 2 }),
  );
  expect(alpha.getByTestId('provider-card-route-share')).toHaveTextContent('30%');

  rerender(<ProviderCardGrid providers={allProviders} routingRevision="revision" routingEditing />);
  expect(screen.getByTestId('provider-share-alpha')).toHaveTextContent('30%');
});

test('a single tier stays numbered and distinguishes zero weight from a rounded zero share', () => {
  const allProviders = [
    providerStub({ id: 'normal', weight: 10000 }),
    providerStub({ id: 'tiny', weight: 1 }),
    providerStub({ id: 'parked', weight: 0 }),
  ];
  const { rerender } = render(<ProviderCardGrid providers={allProviders} routingRevision="revision" />);
  expect(screen.getAllByTestId('provider-card-route-tier')).toHaveLength(3);
  for (const tier of screen.getAllByTestId('provider-card-route-tier')) {
    expect(tier).toHaveTextContent(m['dashboard.providers.routing.tier']({ tier: 1 }));
  }
  expect(within(screen.getByTestId('provider-row-normal')).getByTestId('provider-card-route-share')).toHaveTextContent(
    '100%',
  );
  expect(within(screen.getByTestId('provider-row-tiny')).getByTestId('provider-card-route-share')).toHaveTextContent(
    '0%',
  );
  const parkedLabel = m['dashboard.providers.card.default_parked']();
  expect(within(screen.getByTestId('provider-row-parked')).getByTestId('provider-card-route-share')).toHaveTextContent(
    parkedLabel,
  );

  rerender(
    <ProviderCardGrid
      providers={allProviders.map((provider) => ({ ...provider, weight: 0 }))}
      routingRevision="revision"
    />,
  );
  for (const share of screen.getAllByTestId('provider-card-route-share')) {
    expect(share).toHaveTextContent(parkedLabel);
  }
});

test('a chip filters by enablement and reports its pressed state', () => {
  render(<ProviderCardGrid providers={providers} routingRevision="revision" />);

  const disabled = screen.getByTestId('provider-filter-enablement-disabled');
  expect(disabled).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(disabled);

  expect(disabled).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('provider-filter-enablement-all')).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByTestId('provider-row-beta')).toBeInTheDocument();
  expect(screen.queryByTestId('provider-row-alpha')).not.toBeInTheDocument();
});

test('each chip group is named for assistive technology', () => {
  const { container } = render(<ProviderCardGrid providers={providers} routingRevision="revision" />);

  // The shadcn `Field` wrapper around the search box is also a `group`, so scope this to the chips.
  const groups = [...container.querySelectorAll('[role="group"]')].filter((group) =>
    group.querySelector('[data-testid^="provider-filter-"]'),
  );
  expect(groups.length).toBe(3);
  for (const group of groups) expect(group).toHaveAccessibleName();
});

test('marks the focused Provider', () => {
  render(<ProviderCardGrid providers={providers} routingRevision="revision" focusProviderId="alpha" />);

  expect(screen.getByTestId('provider-row-alpha')).toHaveAttribute('data-focused', 'true');
});

test('deep-link focus does not fire again when the user filters', async () => {
  render(<ProviderCardGrid providers={providers} routingRevision="revision" focusProviderId="alpha" />);
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

test('successful empty responses show zero requests and tokens without inventing health stats', () => {
  // The usage query above resolves to an empty map, which is exactly what the route returns once no
  // Provider saw traffic in the window. Rendering `N/A` there would read as "we could not tell",
  // when the server told us plainly: nobody called it.
  render(<ProviderCardGrid providers={providers} routingRevision="revision" />);

  const card = screen.getByTestId('provider-row-alpha');
  expect(within(card).getByTestId('provider-stat-requests')).toHaveTextContent('0');
  expect(within(card).getByTestId('provider-stat-tokens')).toHaveTextContent('0');
  expect(within(card).getByTestId('provider-stat-success-rate')).toHaveTextContent('—');
  expect(within(card).getByTestId('provider-stat-p95')).toHaveTextContent('—');
  expect(card.textContent).not.toContain('N/A');
});

test('unavailable diagnostics keep tokens unknown even if the usage response confirms zero requests', () => {
  healthMocks.unavailable = true;
  render(<ProviderCardGrid providers={providers} routingRevision="revision" />);

  const card = within(screen.getByTestId('provider-row-alpha'));
  expect(card.getByTestId('provider-stat-requests')).toHaveTextContent('0');
  expect(card.getByTestId('provider-stat-tokens')).toHaveTextContent('—');
});

test('deep-link focus lands once the target Provider arrives on a later render', async () => {
  // A cached list served from `providersQueryOptions` need not contain a Provider the user just
  // created; the background refetch adds it. An effect keyed on the ID alone would have already run
  // and never retried, leaving the deep link with no scroll and no keyboard focus.
  const { rerender } = render(
    <ProviderCardGrid providers={providers} routingRevision="revision" focusProviderId="gamma" />,
  );
  await nextFrames();

  const grown = [...providers, providerStub({ id: 'gamma', name: 'Gamma', kind: ProviderKind.Api })];
  rerender(<ProviderCardGrid providers={grown} routingRevision="revision" focusProviderId="gamma" />);
  await nextFrames();

  expect(document.activeElement).toBe(screen.getByTestId('provider-link-gamma'));
});

test('deep-link focus waits for a filter that hides the target to be cleared', async () => {
  // A filter narrowed before the double-rAF fires leaves the target card out of the document. Giving
  // up there would drop the deep link silently: the card comes back when the filter clears, but
  // nothing would scroll to it or move the keyboard there.
  render(<ProviderCardGrid providers={providers} routingRevision="revision" focusProviderId="beta" />);
  const search = screen.getByTestId('provider-search');
  fireEvent.change(search, { target: { value: 'alpha' } });
  await nextFrames();
  expect(screen.queryByTestId('provider-link-beta')).not.toBeInTheDocument();

  fireEvent.change(search, { target: { value: '' } });
  await nextFrames();

  expect(document.activeElement).toBe(screen.getByTestId('provider-link-beta'));
});

test('renders the empty state when there are no Providers at all', () => {
  render(<ProviderCardGrid providers={[]} routingRevision="revision" />);

  expect(screen.getByText(/No providers configured|未配置提供商/u)).toBeInTheDocument();
});

test('management mode replaces full cards with compact routing rows and restores them on cancel', () => {
  const onRoutingEditingChange = rs.fn();
  const { rerender } = render(
    <ProviderCardGrid
      providers={providers}
      routingRevision="revision"
      routingEditing
      onRoutingEditingChange={onRoutingEditingChange}
    />,
  );

  expect(screen.getByTestId('provider-routing-item-beta')).toHaveTextContent('Beta');
  expect(screen.getByTestId('provider-routing-item-beta')).toHaveTextContent('Provider disabled');
  expect(screen.getByTestId('provider-routing-item-alpha')).toHaveTextContent('Alpha');
  expect(screen.getByTestId('provider-share-beta')).toHaveTextContent('100%');
  expect(screen.getByTestId('provider-share-alpha')).toHaveTextContent('100%');
  expect(screen.queryByTestId(/^provider-row-/u)).not.toBeInTheDocument();
  expect(screen.queryByTestId('provider-card-models-count')).not.toBeInTheDocument();
  expect(screen.getByTestId('provider-routing-save')).toBeDisabled();
  expect(screen.queryByTestId('provider-routing-add-tier')).not.toBeInTheDocument();
  expect(screen.getAllByTestId(/^provider-routing-slot-/u)).toHaveLength(3);

  fireEvent.click(screen.getByTestId('provider-routing-cancel'));
  expect(onRoutingEditingChange).toHaveBeenCalledWith(false);
  rerender(
    <ProviderCardGrid
      providers={providers}
      routingRevision="revision"
      routingEditing={false}
      onRoutingEditingChange={onRoutingEditingChange}
    />,
  );
  expect(screen.getByTestId('provider-search')).toBeInTheDocument();
  expect(screen.getAllByTestId(/^provider-row-/u)).toHaveLength(2);
  expect(routingMocks.mutate).not.toHaveBeenCalled();
});

test('only the explicit handles become draggable controls', async () => {
  const sameTierProviders = providers.map((provider) => ({ ...provider, priority: 1 }));
  render(<ProviderCardGrid providers={sameTierProviders} routingRevision="revision" routingEditing />);

  const tier = screen.getByTestId('provider-tier-1');
  const item = screen.getByTestId('provider-routing-item-alpha');
  const tierHandle = screen.getByRole('button', { name: /Drag tier|拖动梯队|ドラッグ|드래그/u });
  const providerHandle = screen.getByLabelText('Drag Provider alpha');
  await waitFor(() => expect(tierHandle).toHaveAttribute('aria-roledescription', 'draggable'));

  expect(tier).not.toHaveAttribute('role', 'button');
  expect(item).not.toHaveAttribute('role', 'button');
  expect(tierHandle).not.toHaveAttribute('aria-disabled', 'true');
  expect(providerHandle).not.toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByTestId('provider-share-slider-alpha')).toBeEnabled();
});

test('tier keyboard drag collapses every tier until the drag is canceled', async () => {
  Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [] });
  render(<ProviderCardGrid providers={providers} routingRevision="revision" routingEditing />);

  const tierHandles = screen.getAllByRole('button', { name: /Drag tier|拖动梯队|ドラッグ|드래그/u });
  const alphaList = screen.getByTestId('provider-routing-item-alpha').parentElement;
  const betaList = screen.getByTestId('provider-routing-item-beta').parentElement;
  expect(alphaList).not.toBeNull();
  expect(betaList).not.toBeNull();
  await waitFor(() => expect(tierHandles[0]).toHaveAttribute('aria-roledescription', 'draggable'));

  tierHandles[0]!.focus();
  fireEvent.keyDown(tierHandles[0]!, { key: ' ', code: 'Space' });
  await waitFor(() => {
    expect(alphaList).toHaveAttribute('aria-hidden', 'true');
    expect(betaList).toHaveAttribute('aria-hidden', 'true');
  });

  fireEvent.keyDown(tierHandles[0]!, { key: 'Escape', code: 'Escape' });
  await waitFor(() => {
    expect(alphaList).not.toHaveAttribute('aria-hidden');
    expect(betaList).not.toHaveAttribute('aria-hidden');
  });
});

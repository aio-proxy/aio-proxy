import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { afterEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { providerStub } from '../lib/provider-fixtures';
import { DeleteProviderDialogStub } from './delete-provider-dialog-stub';
import { ProvidersPage } from './providers-page';

const queryMocks = rs.hoisted(() => ({
  providers: { providers: [] as DashboardProviderSummary[], routingRevision: 'revision' },
  failed: false,
  refetches: 0,
}));

const invalidProvider = (): DashboardProviderSummary =>
  providerStub({
    id: 'broken',
    kind: 'api',
    state: {
      status: 'unavailable',
      diagnostic: {
        code: 'PROVIDER_CONFIG_INVALID',
        summary: 'Invalid Provider configuration.',
        retryable: false,
        occurredAt: '2026-08-04T00:00:00.000Z',
      },
    },
  });

// Match the providers key exactly. A `queryKey[0] === 'providers'` prefix test would also swallow
// each card's `['providers', id, 'quota']` key and hand it the provider list as its snapshot.
rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    if (JSON.stringify(options.queryKey) === JSON.stringify(['providers'])) {
      return {
        data: queryMocks.providers,
        isLoading: false,
        isPending: false,
        isError: queryMocks.failed,
        refetch: () => {
          queryMocks.refetches += 1;
        },
      };
    }
    // The card's quota query returns a snapshot, not a lookup map; hand it nothing rather than a Map.
    if (options.queryKey[2] === 'quota') {
      return { data: undefined, isLoading: false, isPending: false, isError: true, refetch: () => {} };
    }
    return { data: new Map(), isLoading: false, isPending: false, isError: false, refetch: () => {} };
  },
}));

rs.mock('../components/delete-provider-dialog', () => ({ DeleteProviderDialog: DeleteProviderDialogStub }));
rs.mock('../components/provider-quota-ring', () => ({ ProviderQuotaRing: () => null }));
rs.mock('../hooks/use-provider-enabled-mutation', () => ({
  useProviderEnabledMutation: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../hooks/use-provider-routing-mutation', () => ({
  useProviderRoutingMutation: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('@tanstack/react-router', () => ({
  Link: 'a',
}));

afterEach(() => {
  rs.restoreAllMocks();
  queryMocks.providers.providers = [];
  queryMocks.failed = false;
  queryMocks.refetches = 0;
});

describe('providers page', () => {
  test('offers a new-provider action linking to /providers/new', () => {
    render(<ProvidersPage />);

    const action = screen.getByTestId('new-provider-button');
    expect(action).toHaveAttribute('to', '/providers/new');
    expect(action).not.toHaveAttribute('params');
  });

  test('opens Provider tier management from the page action and returns on cancel', () => {
    queryMocks.providers.providers = [providerStub({ id: 'alpha' })];
    render(<ProvidersPage />);

    const manage = screen.getByTestId('provider-routing-manage');
    fireEvent.click(manage);

    expect(screen.queryByTestId('provider-search')).not.toBeInTheDocument();
    expect(screen.getByTestId('provider-routing-item-alpha')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-routing-manage')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('provider-routing-cancel'));

    expect(screen.getByTestId('provider-search')).toBeInTheDocument();
    expect(screen.getByTestId('provider-routing-manage')).toBeInTheDocument();
    expect(screen.getByTestId('provider-row-alpha')).toBeInTheDocument();
  });

  test('renders each Provider as a card whose name links straight to its editor', () => {
    queryMocks.providers.providers = [
      providerStub({ id: 'carpool', name: 'Carpool', kind: 'api', clientModels: ['model-1'] }),
    ];
    render(<ProvidersPage />);

    const card = within(screen.getByTestId('provider-row-carpool'));
    expect(card.getByText('Carpool')).toBeTruthy();
    // The ID is the hover title only; the card never spends a line on it.
    expect(card.queryByText('carpool')).toBeNull();
    expect(card.getByTestId('provider-link-carpool')).toHaveAttribute('to', '/providers/$id/edit');
    expect(card.getByTestId('provider-card-detail')).toHaveTextContent('API');
    // No table survives the redesign, so no header row should either.
    expect(screen.queryByRole('columnheader')).toBeNull();
    expect(screen.queryByRole('button', { name: /Previous|上一页/u })).toBeNull();
  });

  test('keeps an invalid Provider diagnostic and non-actionable', () => {
    queryMocks.providers.providers = [invalidProvider()];
    render(<ProvidersPage />);

    const card = within(screen.getByTestId('provider-row-broken'));
    expect(card.queryByRole('link')).toBeNull();
    expect(card.queryByRole('switch')).toBeNull();
    expect(card.getByText('Invalid Provider configuration.')).toBeTruthy();
    // Deletion is the only thing a Provider the editor cannot represent can still offer.
    expect(card.getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual([
      'provider-card-delete',
    ]);
  });

  test('highlights a focused provider', async () => {
    queryMocks.providers.providers = Array.from({ length: 11 }, (_, index) =>
      providerStub({ id: `provider-${index}` }),
    );

    render(<ProvidersPage focusProviderId="provider-10" />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-row-provider-10')).toHaveAttribute('data-focused', 'true');
    });
  });

  // A failed query used to fall through to the list's own empty state, so a user whose backend is
  // down was told they have no providers configured — and invited to create one.
  test('a failed providers query explains itself and offers a retry', () => {
    queryMocks.failed = true;

    render(<ProvidersPage />);

    expect(screen.getByTestId('providers-load-error')).toHaveTextContent(m['dashboard.providers.list_load_failed']());
    expect(screen.queryByText(m['dashboard.providers.empty_state']())).toBeNull();

    fireEvent.click(screen.getByTestId('providers-load-retry'));

    expect(queryMocks.refetches).toBe(1);
  });

  test('shows a catalog warning returned by OAuth login', () => {
    render(<ProvidersPage warning="catalog_unavailable" />);
    expect(screen.getByRole('status')).toHaveTextContent(/catalog|模型目录/u);
  });
});

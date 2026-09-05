import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type React from 'react';

import { queryKeys } from '@/lib/query-keys';

import { providerStub } from '../../lib/provider-fixtures';
import { ProviderCard } from './provider-card';

rs.mock('@tanstack/react-router', () => ({ Link: 'a' }));
rs.mock('../../hooks/use-provider-enabled-mutation', () => ({
  useProviderEnabledMutation: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderDelete: () => ({ mutate: rs.fn(), isPending: false }),
}));
rs.mock('../provider-quota-ring', () => ({ ProviderQuotaRing: () => <span data-testid="quota-ring" /> }));

const baseProps = {
  routing: undefined,
  health: undefined,
  usage: undefined,
  usagePending: false,
  pluginLabel: undefined,
  pluginIcon: undefined,
  focused: false,
  onDelete: () => {},
};

// The card calls `useQuery` unconditionally, so every render needs a client in scope.
const renderCard = (element: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
};

test('shows the display name and keeps the Provider ID to the hover title', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'carpool', name: 'Carpool' })} />);

  expect(screen.getByText('Carpool')).toBeInTheDocument();
  expect(screen.getByTitle('carpool')).toBeInTheDocument();
  expect(screen.queryByText('carpool')).not.toBeInTheDocument();
});

test('the card body is one link and never a nested-interactive button', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({ id: 'p', name: 'P' })}
      routing={{ tier: 1, share: 100, parked: false }}
    />,
  );

  const card = screen.getByTestId('provider-row-p');
  expect(card).not.toHaveAttribute('role', 'button');
  expect(card.querySelectorAll('a')).toHaveLength(1);
  expect(screen.getByTestId('provider-link-p')).toBeInTheDocument();
  expect(card).toContainElement(screen.getByTestId('provider-card-routing'));
});

test('an API Provider with one protocol names it on line 2 and stacks its icon on line 1', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'gateway',
        kind: ProviderKind.Api,
        protocols: [ProviderProtocol.OpenAICompatible],
      })}
    />,
  );

  expect(screen.getByTestId('provider-protocol-stack')).toBeInTheDocument();
  expect(screen.getByTestId('provider-card-detail')).toHaveTextContent('OpenAI Compatible');
});

test('several protocols collapse to one word so line 2 never wraps', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'gateway',
        kind: ProviderKind.Api,
        protocols: [ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic],
      })}
    />,
  );

  const detail = screen.getByTestId('provider-card-detail');
  expect(screen.getByTestId('provider-protocols-multi')).toBeInTheDocument();
  expect(detail).not.toHaveTextContent('OpenAI Compatible');
  expect(detail).not.toHaveTextContent('Anthropic');
});

test('keeps unknown usage and health distinct from zero requests', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'p', priority: 5, weight: 3 })} />);

  expect(screen.getByTestId('provider-stat-requests')).toHaveTextContent('N/A');
  expect(screen.getByTestId('provider-stat-success-rate')).toHaveTextContent('—');
  expect(screen.getByTestId('provider-stat-p95')).toHaveTextContent('—');
  expect(screen.getByTestId('provider-stat-throughput')).toHaveTextContent('—');
});

test('groups request volume with health and shows the count only once', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({ id: 'p' })}
      usage={{ requestCount: 1200n }}
      health={{ successRate: 0.985, p95LatencyMs: 20_090, outputTokensPerSecond: 42.56 }}
    />,
  );

  expect(screen.getByTestId('provider-stat-requests')).toHaveTextContent('1.2K');
  expect(screen.getByTestId('provider-row-p').textContent?.match(/1\.2K/gu)).toHaveLength(1);
  expect(screen.getByTestId('provider-stat-success-rate')).toHaveTextContent('98.5%');
  expect(screen.getByTestId('provider-stat-p95')).toHaveTextContent('20.09 s');
  expect(screen.getByTestId('provider-stat-throughput')).toHaveTextContent('42.6 tok/s');
});

test.each([
  [null, '—'],
  [0, '0 tok/s'],
])('distinguishes throughput %s from unavailable samples', (outputTokensPerSecond, expected) => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({ id: 'p' })}
      health={{ successRate: 1, p95LatencyMs: 100, outputTokensPerSecond }}
    />,
  );
  expect(screen.getByTestId('provider-stat-throughput')).toHaveTextContent(expected);
});

test('pending request volume stays pending even if an earlier value is available', () => {
  renderCard(
    <ProviderCard {...baseProps} provider={providerStub({ id: 'p' })} usage={{ requestCount: 1200n }} usagePending />,
  );
  expect(screen.getByTestId('provider-stat-requests')).toHaveTextContent('…');
  expect(screen.queryByText('1.2K')).toBeNull();
});

test('an unavailable Provider shows its diagnostic prominently', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'p',
        state: {
          status: 'unavailable',
          diagnostic: {
            code: 'CATALOG_UNAVAILABLE',
            summary: 'Catalog down',
            retryable: true,
            occurredAt: '2026-09-01T00:00:00.000Z',
          },
        },
      })}
    />,
  );

  const diagnostic = screen.getByTestId('provider-card-diagnostic');
  expect(diagnostic).toHaveTextContent('Catalog down');
  expect(diagnostic).toHaveTextContent('CATALOG_UNAVAILABLE');
  // Noninteractive content must stay under the identity link's full-card overlay, or it would punch
  // a dead hole in the card's click target.
  expect(diagnostic.className).not.toContain('z-10');
  expect(screen.queryByTestId('provider-card-diagnostic-hint')).not.toBeInTheDocument();
});

test('a ready Provider carrying a diagnostic gets the amber line-2 suffix, not the red box', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'p',
        state: {
          status: 'ready',
          diagnostic: {
            code: 'CATALOG_UNAVAILABLE',
            summary: 'Model list may be out of date',
            retryable: true,
            occurredAt: '2026-09-01T00:00:00.000Z',
          },
        },
      })}
    />,
  );

  expect(screen.getByTestId('provider-card-diagnostic-hint')).toHaveTextContent('Model list may be out of date');
  expect(screen.queryByTestId('provider-card-diagnostic')).not.toBeInTheDocument();
});

test('an invalid Provider offers deletion and nothing else', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'oops', kind: 'invalid', enabled: false })} />);

  expect(screen.getByTestId('provider-card-invalid')).toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(screen.queryByTestId('provider-link-oops')).not.toBeInTheDocument();
  expect(screen.getByTestId('provider-card-delete')).toBeInTheDocument();
});

test('a disabled Provider can still be opened and enabled', () => {
  renderCard(
    <ProviderCard {...baseProps} provider={providerStub({ id: 'p', kind: ProviderKind.Api, enabled: false })} />,
  );

  expect(screen.getByTestId('provider-link-p')).toBeInTheDocument();
  expect(screen.getByRole('switch')).not.toBeChecked();
  expect(screen.getByRole('switch')).toBeEnabled();
});

test('an invalid Provider still shows why its configuration could not be parsed', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({
        id: 'oops',
        kind: 'invalid',
        enabled: false,
        state: {
          status: 'unavailable',
          diagnostic: {
            code: 'PROVIDER_CONFIG_INVALID',
            summary: 'baseURL must be an absolute URL',
            retryable: false,
            occurredAt: '2026-09-01T00:00:00.000Z',
          },
        },
      })}
    />,
  );

  const diagnostic = screen.getByTestId('provider-card-diagnostic');
  expect(diagnostic).toHaveTextContent('baseURL must be an absolute URL');
  expect(diagnostic).toHaveTextContent('PROVIDER_CONFIG_INVALID');
});

test('a Provider that lost quota support stops showing the previous account plan', () => {
  // Disabling the query leaves whatever it already cached in place, so the plan has to be read through
  // `hasQuota` as well; otherwise a reused Provider ID keeps advertising the retired account's plan.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.providerQuota('reused'), { snapshot: { items: [], plan: 'Allegro' } });

  render(
    <QueryClientProvider client={client}>
      <ProviderCard {...baseProps} provider={providerStub({ id: 'reused', name: 'Reused', hasQuota: false })} />
    </QueryClientProvider>,
  );

  expect(screen.queryByText('Allegro')).not.toBeInTheDocument();
  expect(screen.queryByTestId('provider-plan-loading')).not.toBeInTheDocument();
});

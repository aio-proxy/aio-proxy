import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type React from 'react';

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
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'p', name: 'P' })} />);

  const card = screen.getByTestId('provider-row-p');
  expect(card).not.toHaveAttribute('role', 'button');
  expect(card.querySelectorAll('a')).toHaveLength(1);
  expect(screen.getByTestId('provider-link-p')).toBeInTheDocument();
});

test('an API Provider lists its protocols on line 2 and stacks their icons on line 1', () => {
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

  expect(screen.getByTestId('provider-protocol-stack')).toBeInTheDocument();
  expect(screen.getByTestId('provider-card-detail')).toHaveTextContent('OpenAI Compatible');
  expect(screen.getByTestId('provider-card-detail')).toHaveTextContent('Anthropic');
});

test('renders the routing and health stats with dashes when unavailable', () => {
  renderCard(<ProviderCard {...baseProps} provider={providerStub({ id: 'p', priority: 5, weight: 3 })} />);

  expect(screen.getByTestId('provider-stat-priority')).toHaveTextContent('5');
  expect(screen.getByTestId('provider-stat-weight')).toHaveTextContent('3');
  expect(screen.getByTestId('provider-stat-success-rate')).toHaveTextContent('—');
  expect(screen.getByTestId('provider-stat-p95')).toHaveTextContent('—');
});

test('defaults priority to 0 and weight to 1 and formats health', () => {
  renderCard(
    <ProviderCard
      {...baseProps}
      provider={providerStub({ id: 'p' })}
      health={{ successRate: 0.985, p95LatencyMs: 1234 }}
    />,
  );

  expect(screen.getByTestId('provider-stat-priority')).toHaveTextContent('0');
  expect(screen.getByTestId('provider-stat-weight')).toHaveTextContent('1');
  expect(screen.getByTestId('provider-stat-success-rate')).toHaveTextContent('98.5%');
  expect(screen.getByTestId('provider-stat-p95')).toHaveTextContent('1234');
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

test('a disabled Provider is dimmed but still interactive', () => {
  renderCard(
    <ProviderCard {...baseProps} provider={providerStub({ id: 'p', kind: ProviderKind.Api, enabled: false })} />,
  );

  expect(screen.getByTestId('provider-row-p').className).toContain('opacity-55');
  expect(screen.getByRole('switch')).toBeInTheDocument();
});

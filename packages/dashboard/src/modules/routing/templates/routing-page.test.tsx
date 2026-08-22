import type { DashboardRoutingModel, DashboardRoutingModelsResponse, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { RoutingPage } from './routing-page';

const mocks = rs.hoisted(() => ({
  query: {
    data: undefined as DashboardRoutingModelsResponse | undefined,
    isError: false,
    isLoading: false,
    refetch: rs.fn(),
  },
  mutate: rs.fn(),
  mutationPending: false,
  mutationError: null as Error | null,
  mutationReset: rs.fn(),
}));

rs.mock('../hooks/use-routing-query', () => ({
  useRoutingQuery: () => mocks.query,
}));

rs.mock('../hooks/use-routing-mutation', () => ({
  useRoutingMutation: () => ({
    mutate: mocks.mutate,
    isPending: mocks.mutationPending,
    error: mocks.mutationError,
    reset: mocks.mutationReset,
  }),
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props} />
  ),
}));

const routingNumber = (effective: number, authored?: number) => ({
  ...(authored === undefined ? {} : { authored }),
  effective,
  wasNormalized: authored !== undefined && authored !== effective,
});

const provider = (
  values: Partial<DashboardRoutingProvider> & Pick<DashboardRoutingProvider, 'id'>,
): DashboardRoutingProvider => ({
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' },
  defaults: { priority: routingNumber(0), weight: routingNumber(1) },
  effective: {
    priority: 0,
    weight: 1,
    prioritySource: 'provider',
    weightSource: 'provider',
    eligible: true,
    share: 1,
  },
  ...values,
});

const model = (
  values: Partial<DashboardRoutingModel> & Pick<DashboardRoutingModel, 'modelId'>,
): DashboardRoutingModel => {
  const providers = values.providers ?? [provider({ id: `${values.modelId}-provider` })];
  return {
    revision: 'rev-1',
    baselineProviderIds: providers.map((entry) => entry.id),
    providerCount: providers.length,
    eligibleProviderCount: providers.filter((entry) => entry.effective.eligible).length,
    hasOverrides: false,
    tiers: [
      {
        priority: 0,
        providers: providers
          .filter((entry) => entry.effective.eligible)
          .map((entry) => ({
            providerId: entry.id,
            weight: entry.effective.weight,
            share: entry.effective.share ?? 1,
          })),
      },
    ],
    providers,
    ...values,
  };
};

afterEach(() => {
  mocks.query.data = undefined;
  mocks.query.isError = false;
  mocks.query.isLoading = false;
  mocks.query.refetch.mockReset();
  mocks.mutate.mockReset();
  mocks.mutationPending = false;
  mocks.mutationError = null;
  mocks.mutationReset.mockReset();
});

test('renders all known models from the routing query including unavailable routes', () => {
  mocks.query.data = {
    writable: true,
    models: [
      model({ modelId: 'openai/gpt-5' }),
      model({
        modelId: 'disabled-model',
        eligibleProviderCount: 0,
        tiers: [],
        providers: [
          provider({
            id: 'off',
            effective: {
              priority: 0,
              weight: 0,
              prioritySource: 'provider',
              weightSource: 'model',
              eligible: false,
              share: null,
            },
          }),
        ],
      }),
      model({ modelId: 'solo-model' }),
    ],
  };

  render(<RoutingPage />);

  expect(screen.getByTestId('routing-row-openai/gpt-5')).toBeInTheDocument();
  expect(screen.getByTestId('routing-row-disabled-model')).toBeInTheDocument();
  expect(screen.getByTestId('routing-row-solo-model')).toBeInTheDocument();
});

test('opens the editor Sheet from a row Edit action', () => {
  mocks.query.data = { writable: true, models: [model({ modelId: 'solo-model' })] };

  render(<RoutingPage />);
  fireEvent.click(
    within(screen.getByTestId('routing-row-solo-model')).getByRole('button', { name: /Edit|編集|편집|编辑|編輯/u }),
  );

  expect(screen.getByTestId('routing-editor-sheet')).toBeInTheDocument();
  expect(screen.getByTestId('routing-preview')).toBeInTheDocument();
});

test('shows Retry when the routing query fails', () => {
  mocks.query.isError = true;

  render(<RoutingPage />);

  expect(screen.getByRole('alert')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Retry|再試|다시|重试|重試/u }));
  expect(mocks.query.refetch).toHaveBeenCalled();
});

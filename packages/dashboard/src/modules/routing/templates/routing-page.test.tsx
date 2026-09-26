import type { DashboardRoutingModel, DashboardRoutingModelsResponse, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as renderComponent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { RoutingPage } from './routing-page';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const render = (ui: React.ReactElement) => renderComponent(ui, { wrapper });

const mocks = rs.hoisted(() => ({
  query: {
    data: undefined as DashboardRoutingModelsResponse | undefined,
    isError: false,
    isLoading: false,
    refetch: rs.fn(),
  },
  trafficMode: 'pending' as 'pending' | 'error',
}));

rs.mock('../hooks/use-routing-query', () => ({
  useRoutingQuery: () => mocks.query,
}));

rs.mock('../services/routing-traffic-service', () => ({
  routingTrafficQueryOptions: (range: string) => ({
    queryKey: ['routing-traffic', range],
    queryFn: () => {
      if (mocks.trafficMode === 'error') throw new Error('routing traffic failed');
      return new Promise(() => undefined);
    },
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

const modelFixture = (modelId: string, catalog?: DashboardRoutingModel['catalog']) =>
  model({ modelId, ...(catalog === undefined ? {} : { catalog }) });

const mockRoutingModels = (data: DashboardRoutingModelsResponse) => {
  mocks.query.data = data;
};

const mockRoutingTrafficPending = () => {
  mocks.trafficMode = 'pending';
};

const mockRoutingTrafficError = () => {
  mocks.trafficMode = 'error';
};

const routingPageProps = {
  search: { range: '24h' as const },
  onSearchChange: rs.fn(),
};

afterEach(() => {
  queryClient.clear();
  mocks.query.data = undefined;
  mocks.query.isError = false;
  mocks.query.isLoading = false;
  mocks.query.refetch.mockReset();
  mocks.trafficMode = 'pending';
  routingPageProps.onSearchChange.mockReset();
});

test('renders the list from routing models alone when traffic has not landed', () => {
  mockRoutingModels({ writable: true, models: [modelFixture('gpt-5', { lab: 'openai' })] });
  mockRoutingTrafficPending();

  render(<RoutingPage {...routingPageProps} />);

  expect(screen.getByTestId('routing-row-gpt-5')).toBeInTheDocument();
  expect(screen.getByText(/Measuring|统计中/u)).toBeInTheDocument();
});

test('keeps the list fully usable when the traffic query fails', () => {
  mockRoutingModels({ writable: true, models: [modelFixture('gpt-5', { lab: 'openai' })] });
  mockRoutingTrafficError();

  render(<RoutingPage {...routingPageProps} />);

  expect(screen.getByTestId('routing-row-gpt-5')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  render(<RoutingPage {...routingPageProps} />);

  expect(screen.getByTestId('routing-row-openai/gpt-5')).toBeInTheDocument();
  expect(screen.getByTestId('routing-row-disabled-model')).toBeInTheDocument();
  expect(screen.getByTestId('routing-row-solo-model')).toBeInTheDocument();
});

test('no longer renders the editor drawer', () => {
  mockRoutingModels({ writable: true, models: [modelFixture('sonnet')] });

  render(<RoutingPage {...routingPageProps} />);

  expect(screen.queryByTestId(['routing-editor', 'drawer'].join('-'))).not.toBeInTheDocument();
});

test('shows Retry when the routing query fails', () => {
  mocks.query.isError = true;

  render(<RoutingPage {...routingPageProps} />);

  expect(screen.getByRole('alert')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Retry|再試|다시|重试|重試/u }));
  expect(mocks.query.refetch).toHaveBeenCalled();
});

import { m } from '@aio-proxy/i18n';
import type { UsageOverviewRange } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render as renderComponent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { ProviderCatalogProvider, type ProviderCatalogValue } from '@/hooks/use-provider-catalog';

import type { RoutingTrafficBucketsData } from '../../services/routing-traffic-service';
import { RoutingModelTrafficTab } from './routing-model-traffic-tab';

const MODEL_ID = 'traffic-model';
const RANGE: UsageOverviewRange = '24h';

const mocks = rs.hoisted(() => ({
  buckets: undefined as RoutingTrafficBucketsData | undefined,
  /** Throws on every call, standing in for a query that has never succeeded. */
  bucketsFail: false,
}));

rs.mock('../../services/routing-traffic-service', () => ({
  routingTrafficBucketsQueryOptions: (range: UsageOverviewRange, modelId: string) => ({
    queryKey: ['routing-traffic-buckets', range, modelId],
    queryFn: async () => {
      if (mocks.bucketsFail) throw new Error('routing traffic buckets failed');
      return mocks.buckets;
    },
  }),
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderTraffic = (options: {
  readonly buckets: RoutingTrafficBucketsData;
  readonly catalog?: ProviderCatalogValue;
}) => {
  mocks.buckets = options.buckets;

  const rootRoute = createRootRoute();
  const tracesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/traces',
    component: () => null,
  });
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <RoutingModelTrafficTab modelId={MODEL_ID} range={RANGE} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute, tracesRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const routerView = <RouterProvider router={router} />;
  return renderComponent(
    options.catalog === undefined ? (
      routerView
    ) : (
      <ProviderCatalogProvider value={options.catalog}>{routerView}</ProviderCatalogProvider>
    ),
    { wrapper },
  );
};

const bucketsFixture = (providerIds: readonly string[]): RoutingTrafficBucketsData => ({
  range: RANGE,
  modelId: MODEL_ID,
  rangeStart: '2026-09-25T08:00:00.000Z',
  rangeEnd: '2026-09-26T08:00:00.000Z',
  bucketUnit: 'day',
  providerIds: [...providerIds],
  buckets:
    providerIds.length === 0
      ? []
      : [
          {
            key: '2026-09-19T00:00:00.000Z',
            values: Object.fromEntries(providerIds.map((providerId, index) => [providerId, BigInt(index + 1)])),
          },
        ],
});

afterEach(() => {
  queryClient.clear();
  mocks.buckets = undefined;
  mocks.bucketsFail = false;
});

test('stacks one series per provider in the order the response gave', async () => {
  renderTraffic({ buckets: bucketsFixture(['primary', 'fallback']) });

  const chart = await screen.findByTestId('routing-traffic-chart');
  expect(chart.getAttribute('data-series')).toBe('primary,fallback');
});

test('shows an empty state rather than an empty chart when nothing was served', async () => {
  // Also the reading when every request in the window failed: failed roots are not served traffic, so
  // the buckets are empty even though attempts were made, and the card must not come up blank.
  renderTraffic({ buckets: { ...bucketsFixture([]), providerIds: [], buckets: [] } });

  expect(await screen.findByText(/No traffic|无流量/u)).toBeInTheDocument();
  expect(screen.queryByTestId('routing-traffic-chart')).toBeNull();
});

test('links out to Traces filtered to this model', async () => {
  renderTraffic({ buckets: bucketsFixture(['primary']) });

  const link = await screen.findByRole('link', { name: /Traces/u });
  expect(link).toHaveAttribute('href', expect.stringContaining('requestedModelId'));
});

test('shows the error screen when a traffic query has nothing cached', async () => {
  // Nothing has ever succeeded, so there is no measurement to fall back on.
  mocks.bucketsFail = true;
  renderTraffic({ buckets: bucketsFixture(['primary']) });

  expect(await screen.findByText(m['dashboard.routing.traffic.load_failed']())).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('keeps the cached measurements up when a later refetch fails', async () => {
  // A query that has already succeeded keeps its payload when a later fetch fails. Blanking a working
  // chart over a transient failure throws away the numbers the operator came here to read.
  const cached = bucketsFixture(['primary']);
  queryClient.setQueryData(['routing-traffic-buckets', RANGE, MODEL_ID], cached);
  mocks.bucketsFail = true;

  renderTraffic({ buckets: cached });

  // The chart survives, behind a notice that the refresh failed rather than the error screen.
  expect(await screen.findByTestId('routing-traffic-chart')).toBeInTheDocument();
  // The cached chart shows at once; the notice follows when the background refetch fails.
  expect(await screen.findByText(m['dashboard.routing.traffic.refresh_failed']())).toBeInTheDocument();
  expect(screen.queryByText(m['dashboard.routing.traffic.load_failed']())).not.toBeInTheDocument();
});

test('flags a failed refresh over a cached empty measurement too', async () => {
  // "No traffic" is as stale as a chart once the refetch that would confirm it has failed.
  const cached = { ...bucketsFixture([]), providerIds: [], buckets: [] };
  queryClient.setQueryData(['routing-traffic-buckets', RANGE, MODEL_ID], cached);
  mocks.bucketsFail = true;

  renderTraffic({ buckets: cached });

  expect(await screen.findByText(m['dashboard.routing.traffic.refresh_failed']())).toBeInTheDocument();
  expect(screen.getByText(/No traffic|无流量/u)).toBeInTheDocument();
});

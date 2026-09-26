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

import type {
  RoutingTrafficBucketsData,
  RoutingTrafficData,
  RoutingTrafficProviderTotals,
} from '../../services/routing-traffic-service';
import { RoutingModelTrafficTab } from './routing-model-traffic-tab';

const MODEL_ID = 'traffic-model';
const RANGE: UsageOverviewRange = '24h';

const mocks = rs.hoisted(() => ({
  buckets: undefined as RoutingTrafficBucketsData | undefined,
  traffic: undefined as RoutingTrafficData | undefined,
}));

rs.mock('../../services/routing-traffic-service', () => ({
  routingTrafficBucketsQueryOptions: (range: UsageOverviewRange, modelId: string) => ({
    queryKey: ['routing-traffic-buckets', range, modelId],
    queryFn: async () => mocks.buckets,
  }),
  routingTrafficQueryOptions: (range: UsageOverviewRange) => ({
    queryKey: ['routing-traffic', range],
    queryFn: async () => mocks.traffic,
  }),
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderTraffic = (options: {
  readonly buckets: RoutingTrafficBucketsData;
  readonly traffic?: RoutingTrafficData;
}) => {
  mocks.buckets = options.buckets;
  mocks.traffic =
    options.traffic ??
    ({
      range: RANGE,
      rangeStart: options.buckets.rangeStart,
      rangeEnd: options.buckets.rangeEnd,
      models: [
        {
          modelId: MODEL_ID,
          providers: options.buckets.providerIds.map((providerId) => providerTotals(providerId)),
        },
      ],
    } satisfies RoutingTrafficData);

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

  return renderComponent(<RouterProvider router={router} />, { wrapper });
};

const providerTotals = (
  providerId: string,
  overrides: Partial<RoutingTrafficProviderTotals> = {},
): RoutingTrafficProviderTotals => ({
  providerId,
  finalCount: 2n,
  attemptCount: 10n,
  successCount: 4n,
  p95LatencyMs: null,
  ...overrides,
});

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
  mocks.traffic = undefined;
});

test('stacks one series per provider in the order the response gave', async () => {
  renderTraffic({ buckets: bucketsFixture(['primary', 'fallback']) });

  expect(await screen.findByText('primary')).toBeInTheDocument();
  expect(screen.getByText('fallback')).toBeInTheDocument();
});

test('summarises attempts, successes and p95 per provider', async () => {
  renderTraffic({
    buckets: bucketsFixture(['primary']),
    traffic: {
      range: RANGE,
      rangeStart: '2026-09-25T08:00:00.000Z',
      rangeEnd: '2026-09-26T08:00:00.000Z',
      models: [
        {
          modelId: MODEL_ID,
          providers: [
            providerTotals('primary', {
              finalCount: 2n,
              attemptCount: 10n,
              successCount: 4n,
              p95LatencyMs: null,
            }),
          ],
        },
      ],
    },
  });

  expect(await screen.findByRole('table')).toBeInTheDocument();
  expect(screen.getByText('10')).toBeInTheDocument();
  expect(screen.getByText('40%')).toBeInTheDocument();
  expect(screen.queryByText(/0 ms/u)).not.toBeInTheDocument();
});

test('shows an empty state rather than an empty chart when nothing was served', async () => {
  renderTraffic({ buckets: { ...bucketsFixture([]), providerIds: [], buckets: [] } });

  expect(await screen.findByText(/No traffic|无流量/u)).toBeInTheDocument();
});

test('links out to Traces filtered to this model', async () => {
  renderTraffic({ buckets: bucketsFixture(['primary']) });

  const link = await screen.findByRole('link', { name: /Traces/u });
  expect(link).toHaveAttribute('href', expect.stringContaining('requestedModelId'));
});

test('shows the summary table without a chart when only attempt-only providers have totals', async () => {
  const { container } = renderTraffic({
    buckets: { ...bucketsFixture([]), providerIds: [], buckets: [] },
    traffic: {
      range: RANGE,
      rangeStart: '2026-09-25T08:00:00.000Z',
      rangeEnd: '2026-09-26T08:00:00.000Z',
      models: [
        {
          modelId: MODEL_ID,
          providers: [
            providerTotals('standby', {
              finalCount: 0n,
              attemptCount: 5n,
              successCount: 0n,
              p95LatencyMs: null,
            }),
          ],
        },
      ],
    },
  });

  expect(await screen.findByText('standby')).toBeInTheDocument();
  expect(screen.queryByText(/No traffic|无流量/u)).not.toBeInTheDocument();
  expect(container.querySelector('.recharts-responsive-container')).toBeNull();
});

test('lists providers that were attempted but never became the final provider', async () => {
  renderTraffic({
    buckets: bucketsFixture(['primary']),
    traffic: {
      range: RANGE,
      rangeStart: '2026-09-25T08:00:00.000Z',
      rangeEnd: '2026-09-26T08:00:00.000Z',
      models: [
        {
          modelId: MODEL_ID,
          providers: [
            providerTotals('primary', {
              finalCount: 2n,
              attemptCount: 10n,
              successCount: 4n,
              p95LatencyMs: null,
            }),
            providerTotals('standby', {
              finalCount: 0n,
              attemptCount: 5n,
              successCount: 0n,
              p95LatencyMs: null,
            }),
          ],
        },
      ],
    },
  });

  expect(await screen.findByText('standby')).toBeInTheDocument();
  expect(screen.getByText('5')).toBeInTheDocument();
  expect(screen.getByText('0%')).toBeInTheDocument();
});

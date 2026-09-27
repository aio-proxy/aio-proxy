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
import { fireEvent, render as renderComponent, screen } from '@testing-library/react';
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
  mocks.bucketsFail = false;
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

test('shows served alongside attempts so the chart and the table can be reconciled', async () => {
  // The chart plots finalCount while the only count column used to show attemptCount, so a
  // provider with 2 served and 10 attempted put bars summing to 2 directly above a row reading 10
  // with nothing saying they measured different things.
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
            providerTotals('primary', { finalCount: 2n, attemptCount: 10n, successCount: 4n, p95LatencyMs: null }),
          ],
        },
      ],
    },
  });

  await screen.findByRole('table');
  const headers = screen.getAllByRole('columnheader').map((header) => header.textContent?.trim());
  expect(headers).toContain(m['dashboard.routing.traffic.served']());
  expect(headers).toContain(m['dashboard.traces.span_metric_attempts']());

  const cells = [...screen.getByText('primary').closest('tr')!.querySelectorAll('td')].map((cell) =>
    cell.textContent?.trim(),
  );
  // Served then attempts, in the order the headers declare.
  expect(cells.slice(0, 3)).toStrictEqual(['primary', '2', '10']);
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

test('sorts the provider metrics table by served requests', async () => {
  // The rule requires the real table capabilities here, and sorting is the one that matters: it
  // answers "which Provider is carrying this model". 9 versus 10 also pins that the comparison is
  // numeric — ordered as text, "10" would come first.
  renderTraffic({
    buckets: bucketsFixture(['low', 'high']),
    traffic: {
      range: RANGE,
      rangeStart: '2026-09-25T08:00:00.000Z',
      rangeEnd: '2026-09-26T08:00:00.000Z',
      models: [
        {
          modelId: MODEL_ID,
          providers: [
            providerTotals('low', { finalCount: 9n, attemptCount: 9n, successCount: 9n, p95LatencyMs: 10 }),
            providerTotals('high', { finalCount: 10n, attemptCount: 10n, successCount: 10n, p95LatencyMs: 20 }),
          ],
        },
      ],
    },
  });

  await screen.findByRole('table');
  const order = () =>
    screen
      .getAllByRole('row')
      .map((row) => row.getAttribute('data-testid'))
      .filter((id): id is string => id !== null);

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.traffic.served']() }));
  expect(order()).toStrictEqual(['routing-traffic-row-low', 'routing-traffic-row-high']);

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.traffic.served']() }));
  expect(order()).toStrictEqual(['routing-traffic-row-high', 'routing-traffic-row-low']);
});

test('exposes filtering and column visibility on the provider metrics table', async () => {
  // useDataTable creates global-filter and column-visibility state, but it is unreachable unless the
  // shared controls are rendered — the table had sorting and pagination only.
  renderTraffic({
    buckets: bucketsFixture(['primary', 'fallback']),
    traffic: {
      range: RANGE,
      rangeStart: '2026-09-25T08:00:00.000Z',
      rangeEnd: '2026-09-26T08:00:00.000Z',
      models: [
        {
          modelId: MODEL_ID,
          providers: [
            providerTotals('primary', { finalCount: 9n, attemptCount: 9n, successCount: 9n, p95LatencyMs: 10 }),
            providerTotals('fallback', { finalCount: 1n, attemptCount: 1n, successCount: 1n, p95LatencyMs: 20 }),
          ],
        },
      ],
    },
  });

  await screen.findByRole('table');
  expect(screen.getByRole('button', { name: m['dashboard.routing.table.columns']() })).toBeInTheDocument();

  const filter = screen.getByLabelText(m['dashboard.routing.traffic.filter']());
  expect(screen.getByTestId('routing-traffic-row-fallback')).toBeInTheDocument();

  fireEvent.change(filter, { target: { value: 'primary' } });

  // Filtering narrows the rows rather than just holding state nobody can reach.
  expect(screen.getByTestId('routing-traffic-row-primary')).toBeInTheDocument();
  expect(screen.queryByTestId('routing-traffic-row-fallback')).not.toBeInTheDocument();
});

test('shows the error screen when a traffic query has nothing cached', async () => {
  // Nothing has ever succeeded, so there is no measurement to fall back on.
  mocks.bucketsFail = true;
  renderTraffic({ buckets: bucketsFixture(['primary']) });

  expect(await screen.findByText(m['dashboard.routing.load_failed']())).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('keeps the cached measurements up when a later refetch fails', async () => {
  // A query that has already succeeded keeps its payload when a later fetch fails. Blanking a working
  // chart over a transient failure throws away the numbers the operator came here to read.
  const cached = bucketsFixture(['primary']);
  queryClient.setQueryData(['routing-traffic-buckets', RANGE, MODEL_ID], cached);
  mocks.bucketsFail = true;

  renderTraffic({ buckets: cached });

  // The summary survives, behind a notice that the refresh failed rather than the error screen.
  expect(await screen.findByRole('table')).toBeInTheDocument();
  expect(screen.getByText(m['dashboard.routing.traffic.refresh_failed']())).toBeInTheDocument();
  expect(screen.queryByText(m['dashboard.routing.load_failed']())).not.toBeInTheDocument();
});

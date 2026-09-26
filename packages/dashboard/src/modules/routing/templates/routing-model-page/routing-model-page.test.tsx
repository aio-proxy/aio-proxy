import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, fireEvent, render as renderComponent, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useSyncExternalStore } from 'react';

import type { RoutingTrafficData } from '../../services/routing-traffic-service';
import { RoutingModelPage } from './routing-model-page';

const mutationMocks = rs.hoisted(() => ({
  mutate: rs.fn(),
  isPending: false,
  error: null as Error | null,
  reset: rs.fn(),
}));

const routingQueryMocks = rs.hoisted(() => ({
  data: { writable: true, models: [] as DashboardRoutingModel[] },
  isLoading: false,
  isError: false,
  refetch: rs.fn(),
  revision: 0,
  listeners: new Set<() => void>(),
}));

const trafficMocks = rs.hoisted(() => ({
  traffic: undefined as RoutingTrafficData | undefined,
}));

rs.mock('../../hooks/use-routing-mutation', () => ({
  useRoutingMutation: () => ({
    mutate: mutationMocks.mutate,
    isPending: mutationMocks.isPending,
    error: mutationMocks.error,
    reset: mutationMocks.reset,
  }),
}));

rs.mock('../../hooks/use-routing-query', () => ({
  useRoutingQuery: () => {
    useSyncExternalStore(
      (listener) => {
        routingQueryMocks.listeners.add(listener);
        return () => routingQueryMocks.listeners.delete(listener);
      },
      () => routingQueryMocks.revision,
    );
    return routingQueryMocks;
  },
}));

rs.mock('../../services/routing-traffic-service', () => ({
  routingTrafficQueryOptions: (range: string) => ({
    queryKey: ['routing-traffic', range],
    queryFn: async () =>
      trafficMocks.traffic ?? {
        range,
        rangeStart: '',
        rangeEnd: '',
        models: [],
      },
  }),
  routingTrafficBucketsQueryOptions: () => ({
    queryKey: ['routing-traffic-buckets'],
    queryFn: async () => ({
      range: '24h',
      rangeStart: '',
      rangeEnd: '',
      providerIds: [],
      buckets: [],
    }),
  }),
}));

rs.mock('../../services/models-dev-service', () => ({
  modelsDevSlugsQueryOptions: () => ({
    queryKey: ['models-dev-slugs'],
    queryFn: async () => ({ slugs: [] }),
  }),
  modelsDevLookupQueryOptions: () => ({
    queryKey: ['models-dev-lookup'],
    queryFn: async () => ({ slug: null, metadata: null }),
  }),
}));

rs.mock('@/components/json-editor/json-schema-registry', () => ({
  registerJsonSchema: () => () => undefined,
}));

rs.mock('@/components/json-editor/json-language-service', () => ({
  createJsonLanguageExtensions: () => [],
}));

rs.mock('@/components/code-editor', () => ({
  CodeEditor: ({ id, onChange, value }: { id?: string; onChange?: (next: string) => void; value: string }) => (
    <textarea id={id} value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

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
    priority: values.defaults?.priority.effective ?? 0,
    weight: values.defaults?.weight.effective ?? 1,
    prioritySource: values.override?.priority === undefined ? 'provider' : 'model',
    weightSource: values.override?.weight === undefined ? 'provider' : 'model',
    eligible:
      (values.enabled ?? true) && (values.override?.weight?.effective ?? values.defaults?.weight.effective ?? 1) > 0,
    share: null,
  },
  ...values,
});

const modelFixture = (modelId: string): DashboardRoutingModel => ({
  modelId,
  revision: 'rev-1',
  baselineProviderIds: ['a', 'b'],
  providerCount: 2,
  eligibleProviderCount: 2,
  hasOverrides: false,
  tiers: [
    {
      priority: 0,
      providers: [
        { providerId: 'a', weight: 1, share: 0.5 },
        { providerId: 'b', weight: 1, share: 0.5 },
      ],
    },
  ],
  providers: [
    provider({
      id: 'a',
      name: 'Primary',
      defaults: { priority: routingNumber(0), weight: routingNumber(1) },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.5,
      },
    }),
    provider({
      id: 'b',
      name: 'Secondary',
      defaults: { priority: routingNumber(0), weight: routingNumber(1) },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.5,
      },
    }),
  ],
});

const renderAt = (pathname: string, models: readonly DashboardRoutingModel[]) => {
  routingQueryMocks.data = { writable: true, models: [...models] };
  routingQueryMocks.isLoading = false;
  routingQueryMocks.isError = false;
  trafficMocks.traffic = undefined;

  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/',
    component: () => null,
  });
  const splatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/$',
    component: () => <RoutingModelPage modelId={splatRoute.useParams()._splat ?? ''} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, splatRoute]),
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });
  renderComponent(<RouterProvider router={router} />, { wrapper });
};

interface RenderPageOptions {
  readonly models: readonly DashboardRoutingModel[];
  readonly modelId?: string;
  readonly writable?: boolean;
  readonly isLoading?: boolean;
  readonly isError?: boolean;
}

const renderPage = (options: RenderPageOptions) => {
  const modelId = options.modelId ?? 'sonnet';
  routingQueryMocks.data = {
    writable: options.writable ?? true,
    models: [...options.models],
  };
  routingQueryMocks.isLoading = options.isLoading ?? false;
  routingQueryMocks.isError = options.isError ?? false;
  trafficMocks.traffic = undefined;

  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/',
    component: () => null,
  });
  const splatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/$',
    component: () => <RoutingModelPage modelId={splatRoute.useParams()._splat ?? ''} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, splatRoute]),
    history: createMemoryHistory({ initialEntries: [`/routing/${modelId}`] }),
  });
  const ui = <RouterProvider router={router} />;
  return { ...renderComponent(ui, { wrapper }), router, ui };
};

const dirtyTopology = () => {
  fireEvent.change(screen.getByTestId('routing-share-slider-a').querySelector('input')!, {
    target: { value: '7000' },
  });
};

const rerenderRoutingQuery = () => {
  routingQueryMocks.revision += 1;
  for (const listener of routingQueryMocks.listeners) listener();
};

const selectRange = (range: '7d') => {
  const labels: Record<'7d', string> = {
    '7d': m['dashboard.usage.range_7d'](),
  };
  fireEvent.click(screen.getByRole('tab', { name: labels[range] }));
};

afterEach(() => {
  queryClient.clear();
  mutationMocks.mutate.mockReset();
  mutationMocks.reset.mockReset();
  routingQueryMocks.refetch.mockReset();
});

test('resolves a model id that contains slashes', async () => {
  renderAt('/routing/anthropic/claude-sonnet-4.5', [modelFixture('anthropic/claude-sonnet-4.5')]);

  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('anthropic/claude-sonnet-4.5');
});

test('resolves a single-segment model id too', async () => {
  renderAt('/routing/gpt-5-codex', [modelFixture('gpt-5-codex')]);

  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('gpt-5-codex');
});

test('resolves an id with more than two segments', async () => {
  renderAt('/routing/openrouter/mistralai/mistral-large', [modelFixture('openrouter/mistralai/mistral-large')]);

  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('openrouter/mistralai/mistral-large');
});

test('marks the tab that holds an unsaved change', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByRole('tab', { name: /拓扑|Topology/u });

  dirtyTopology();

  expect(screen.getByRole('tab', { name: /拓扑|Topology/u })).toHaveTextContent(/未保存|Unsaved/u);
});

test('keeps a dirty editor mounted when a refetch fails with cached inventory', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByRole('tab', { name: /拓扑|Topology/u });
  dirtyTopology();

  routingQueryMocks.isError = true;
  act(rerenderRoutingQuery);

  expect(screen.getByRole('tab', { name: /拓扑|Topology/u })).toHaveTextContent(/未保存|Unsaved/u);
  expect(screen.getByRole('alert')).toHaveTextContent(m['dashboard.routing.load_failed']());
});

test('does not show the range selector while the inventory is loading', () => {
  renderPage({ models: [], isLoading: true });

  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
});

test('blocks leaving the page while a draft is unsaved', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByRole('tab', { name: /拓扑|Topology/u });
  dirtyTopology();

  fireEvent.click(screen.getByRole('link', { name: /Routing|路由/u }));

  await waitFor(() => {
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

test('offers a way back rather than blanking when the model is gone', async () => {
  renderPage({ models: [], modelId: 'deleted-model' });

  expect(await screen.findByRole('link', { name: /Routing|路由/u })).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
});

test('keeps one save button for the whole page rather than one per tab', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByRole('tab', { name: /拓扑|Topology/u });

  expect(screen.getAllByRole('button', { name: /保存|Save/u })).toHaveLength(1);
});

test('disables saving when the config is read-only', async () => {
  renderPage({ models: [modelFixture('sonnet')], writable: false });
  await screen.findByRole('tab', { name: /拓扑|Topology/u });

  expect(screen.getByRole('button', { name: /保存|Save/u })).toBeDisabled();
});

test('switching range does not discard an unsaved draft', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByRole('tab', { name: /拓扑|Topology/u });
  dirtyTopology();

  selectRange('7d');

  expect(screen.getByRole('tab', { name: /拓扑|Topology/u })).toHaveTextContent(/未保存|Unsaved/u);
});

test('cancel clears the unsaved marker without saving', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByRole('tab', { name: /拓扑|Topology/u });
  dirtyTopology();

  expect(screen.getByRole('tab', { name: /拓扑|Topology/u })).toHaveTextContent(/未保存|Unsaved/u);
  fireEvent.click(screen.getByRole('button', { name: /Cancel|取消/u }));

  expect(screen.getByRole('tab', { name: /拓扑|Topology/u })).not.toHaveTextContent(/未保存|Unsaved/u);
  expect(mutationMocks.mutate).not.toHaveBeenCalled();
});

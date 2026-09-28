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
import { act, fireEvent, render as renderComponent, screen, waitFor, within } from '@testing-library/react';
import { type ReactNode, useSyncExternalStore } from 'react';

import type { RoutingTrafficData } from '../../services/routing-traffic-service';
import { RoutingModelPage } from './routing-model-page';

const mutationMocks = rs.hoisted(() => ({
  callbacks: undefined as { onError?: (error: Error) => void; onSuccess?: (data: unknown) => void } | undefined,
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
  fail: false,
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
    queryFn: async () => {
      if (trafficMocks.fail) throw new Error('routing traffic failed');
      return (
        trafficMocks.traffic ?? {
          range,
          rangeStart: '',
          rangeEnd: '',
          models: [],
        }
      );
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
  mutationMocks.mutate.mockImplementation(
    (_body: unknown, callbacks?: { onError?: (error: Error) => void; onSuccess?: (data: unknown) => void }) => {
      mutationMocks.callbacks = callbacks;
    },
  );
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
  const weight = screen.getByTestId('routing-weight-a');
  fireEvent.change(weight, { target: { value: '7' } });
  fireEvent.blur(weight);
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
  mutationMocks.isPending = false;
  mutationMocks.error = null;
  mutationMocks.callbacks = undefined;
  trafficMocks.fail = false;
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

test('names the part holding unsaved work in the save bar', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
  expect(screen.queryByTestId('routing-save-bar')).not.toBeInTheDocument();

  dirtyTopology();

  expect(screen.getByTestId('routing-save-bar')).toHaveTextContent(m['dashboard.routing.detail.dirty_route']());
});

test('keeps a dirty editor mounted when a refetch fails with cached inventory', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
  dirtyTopology();

  routingQueryMocks.isError = true;
  act(rerenderRoutingQuery);

  expect(screen.getByTestId('routing-save-bar')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(m['dashboard.routing.load_failed']());
});

test('does not show the range selector while the inventory is loading', () => {
  renderPage({ models: [], isLoading: true });

  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
});

test('blocks leaving the page while a draft is unsaved', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
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

test('keeps one save button for the whole page rather than one per section', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
  dirtyTopology();

  expect(screen.getAllByRole('button', { name: m['dashboard.routing.editor.save']() })).toHaveLength(1);
});

test('locks editing when the config is read-only', async () => {
  renderPage({ models: [modelFixture('sonnet')], writable: false });
  await screen.findByTestId('routing-board');

  expect(screen.getByText(m['dashboard.routing.read_only']())).toBeInTheDocument();
  for (const input of screen.getAllByTestId(/^routing-weight-/u)) expect(input).toBeDisabled();
  expect(screen.queryByTestId('routing-save-bar')).not.toBeInTheDocument();
});

test('switching range does not discard an unsaved draft', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
  dirtyTopology();

  selectRange('7d');

  expect(screen.getByTestId('routing-save-bar')).toBeInTheDocument();
});

test('cancel clears the unsaved marker without saving', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
  dirtyTopology();

  expect(screen.getByTestId('routing-save-bar')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Cancel|取消/u }));

  expect(screen.queryByTestId('routing-save-bar')).not.toBeInTheDocument();
  expect(mutationMocks.mutate).not.toHaveBeenCalled();
});

test('stops accepting edits while a save is in flight', async () => {
  // The save body and the defaults the forms snap back to on success are both snapshotted when Save
  // is pressed, so anything typed while the request is in flight is neither sent nor kept. The
  // controls lock until it settles.
  mutationMocks.isPending = true;
  renderPage({ models: [modelFixture('sonnet')] });

  await screen.findByTestId('routing-board');

  const inputs = screen.getAllByTestId(/^routing-weight-/u);
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) expect(input).toBeDisabled();

  // The config is still writable — the lock is about the in-flight request, not permissions, so the
  // read-only notice must stay away.
  expect(screen.queryByText(m['dashboard.routing.read_only']())).not.toBeInTheDocument();
});

test('accepts edits again once no save is in flight', async () => {
  renderPage({ models: [modelFixture('sonnet')] });

  await screen.findByTestId('routing-board');

  const inputs = screen.getAllByTestId(/^routing-weight-/u);
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) expect(input).toBeEnabled();
});

test('a failed traffic query is reported once, by the Traffic card', async () => {
  // The route rows read "—" for a measurement nobody took; only the Traffic card, which can retry,
  // says the query failed.
  trafficMocks.fail = true;
  renderPage({ models: [modelFixture('sonnet')] });

  expect(await screen.findByText(m['dashboard.routing.traffic.load_failed']())).toBeInTheDocument();
  expect(screen.getAllByText(m['dashboard.routing.traffic.load_failed']())).toHaveLength(1);
});

test('keeps the stale warning up when the reload refetch fails', async () => {
  // A failed refetch still resolves with the last successful payload. Handing that back looked like a
  // reload that had fetched a new revision: the warning cleared and the next save was rejected as
  // stale all over again, with nothing on screen explaining why.
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
  dirtyTopology();

  // handleSubmit is async, so the mutation lands a microtask after the click.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.editor.save']() }));
  });
  act(() => {
    mutationMocks.callbacks?.onError?.(Object.assign(new Error('stale'), { code: 'stale_revision' }));
  });
  expect(screen.getByText(m['dashboard.routing.editor.stale']())).toBeInTheDocument();

  // The refetch fails but the cache still holds the model it had before.
  routingQueryMocks.refetch.mockResolvedValue({
    isError: true,
    data: { writable: true, models: [modelFixture('sonnet')] },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.editor.reload']() }));
  });

  expect(screen.getByText(m['dashboard.routing.editor.stale']())).toBeInTheDocument();
});

test('clears the stale warning when the reload refetch succeeds', async () => {
  renderPage({ models: [modelFixture('sonnet')] });
  await screen.findByTestId('routing-board');
  dirtyTopology();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.editor.save']() }));
  });
  act(() => {
    mutationMocks.callbacks?.onError?.(Object.assign(new Error('stale'), { code: 'stale_revision' }));
  });
  expect(screen.getByText(m['dashboard.routing.editor.stale']())).toBeInTheDocument();

  routingQueryMocks.refetch.mockResolvedValue({
    isError: false,
    data: { writable: true, models: [{ ...modelFixture('sonnet'), revision: 'rev-2' }] },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.editor.reload']() }));
  });

  expect(screen.queryByText(m['dashboard.routing.editor.stale']())).not.toBeInTheDocument();
});

test('turning on a Provider’s own pricing copies the model price and saves it whole', async () => {
  // The config replaces the model's cost wholesale for that Provider. Starting from a blank would
  // silently drop every price the user did not retype, so the switch seeds the model's prices.
  renderPage({ models: [{ ...modelFixture('sonnet'), metadata: { cost: { input: 3, output: 15 } } }] });
  await screen.findByTestId('routing-board');

  const priceCard = within(screen.getByTestId('routing-model-price-card'));
  fireEvent.click(priceCard.getAllByRole('button', { name: m['dashboard.routing.profile.edit']() })[1] as HTMLElement);
  const card = within(await screen.findByTestId('provider-override-a'));
  fireEvent.click(card.getByRole('button', { expanded: false }));
  fireEvent.click(card.getByRole('switch', { name: m['dashboard.routing.profile.provider_cost']() }));

  expect(card.getByLabelText(new RegExp(m['dashboard.routing.editor.metadata_cost_label_input'](), 'u'))).toHaveValue(
    3,
  );
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.profile.drawer_done']() }));
  await waitFor(() => expect(screen.queryByTestId('provider-override-a')).not.toBeInTheDocument());
  expect(screen.getByTestId('routing-save-bar')).toHaveTextContent(m['dashboard.routing.detail.dirty_overrides']());

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: m['dashboard.routing.editor.save']() }));
  });
  expect(mutationMocks.mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({ a: expect.objectContaining({ cost: { input: 3, output: 15 } }) }),
    }),
    expect.anything(),
  );
});

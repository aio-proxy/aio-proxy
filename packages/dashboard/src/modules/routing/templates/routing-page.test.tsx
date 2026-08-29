import type { DashboardRoutingModel, DashboardRoutingModelsResponse, DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as renderComponent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { RoutingPage } from './routing-page';

// The drawer's metadata editor queries the models.dev slug catalog, so the tree needs a QueryClient.
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

rs.mock('../services/models-dev-service', () => ({
  modelsDevSlugsQueryOptions: () => ({
    queryKey: ['models-dev-slugs'],
    queryFn: async () => ({ slugs: [] as string[] }),
  }),
  modelsDevLookupQueryOptions: (id: string) => ({
    queryKey: ['models-dev-lookup', id],
    queryFn: async () => ({ slug: null, metadata: null }),
  }),
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
  queryClient.clear();
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

test('opens the editor drawer from a row Edit action', () => {
  mocks.query.data = { writable: true, models: [model({ modelId: 'solo-model' })] };

  render(<RoutingPage />);
  fireEvent.click(
    within(screen.getByTestId('routing-row-solo-model')).getByRole('button', { name: /Edit|編集|편집|编辑|編輯/u }),
  );

  expect(screen.getByTestId('routing-editor-drawer')).toBeInTheDocument();
  expect(screen.getByTestId('routing-board')).toBeInTheDocument();
});

test('shows Retry when the routing query fails', () => {
  mocks.query.isError = true;

  render(<RoutingPage />);

  expect(screen.getByRole('alert')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Retry|再試|다시|重试|重試/u }));
  expect(mocks.query.refetch).toHaveBeenCalled();
});

const overriddenProvider = (id: string, priority: number, weight: number) =>
  provider({
    id,
    override: { priority: routingNumber(priority, priority), weight: routingNumber(weight, weight) },
    effective: {
      priority,
      weight,
      prioritySource: 'model',
      weightSource: 'model',
      eligible: weight > 0,
      share: null,
    },
  });

const openSoloModelEditor = () => {
  fireEvent.click(
    within(screen.getByTestId('routing-row-solo-model')).getByRole('button', { name: /Edit|編集|편집|编辑|編輯/u }),
  );
};

test('ordinary query refetch keeps the opened editor revision and draft', async () => {
  const opened = model({
    modelId: 'solo-model',
    revision: 'rev-1',
    baselineProviderIds: ['solo-model-provider'],
    providers: [overriddenProvider('solo-model-provider', 10, 1000)],
  });
  mocks.query.data = { writable: true, models: [opened] };

  const { rerender } = render(<RoutingPage />);
  openSoloModelEditor();
  fireEvent.click(screen.getByTestId('routing-reset-solo-model-provider'));

  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'solo-model',
        revision: 'rev-2',
        baselineProviderIds: ['other'],
        providers: [overriddenProvider('solo-model-provider', 10, 1000), provider({ id: 'other' })],
      }),
    ],
  };
  rerender(<RoutingPage />);

  expect(screen.queryByTestId('routing-reset-solo-model-provider')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'solo-model',
        revision: 'rev-1',
        baselineProviderIds: ['solo-model-provider'],
        providers: { 'solo-model-provider': {} },
      },
      expect.any(Object),
    );
  });
});

const armStaleReload = () => {
  mocks.query.refetch.mockImplementation(async () => ({ data: mocks.query.data }));
  mocks.mutate.mockImplementation((_body: unknown, callbacks?: { onError?: (error: Error) => void }) => {
    const error = Object.assign(new Error('stale routing model'), { code: 'stale_revision' });
    mocks.mutationError = error;
    callbacks?.onError?.(error);
  });
};

const reloadEditor = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Reload|再読|다시|重新|重新/u }));
    await mocks.query.refetch.mock.results.at(-1)?.value;
  });
};

test('explicit stale reload adopts the new revision without clearing draft values', async () => {
  armStaleReload();
  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'solo-model',
        revision: 'rev-1',
        baselineProviderIds: ['solo-model-provider'],
        providers: [overriddenProvider('solo-model-provider', 10, 1000)],
      }),
    ],
  };

  render(<RoutingPage />);
  openSoloModelEditor();
  fireEvent.click(screen.getByTestId('routing-reset-solo-model-provider'));
  fireEvent.click(screen.getByTestId('routing-save'));
  expect(await screen.findByRole('button', { name: /Reload|再読|다시|重新|重新/u })).toBeInTheDocument();

  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'solo-model',
        revision: 'rev-2',
        baselineProviderIds: ['solo-model-provider', 'other'],
        providers: [overriddenProvider('solo-model-provider', 10, 1000), provider({ id: 'other' })],
      }),
    ],
  };
  await reloadEditor();

  expect(screen.queryByTestId('routing-reset-solo-model-provider')).not.toBeInTheDocument();
  mocks.mutate.mockClear();
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'solo-model',
        revision: 'rev-2',
        baselineProviderIds: ['solo-model-provider', 'other'],
        providers: { 'solo-model-provider': {}, other: {} },
      },
      expect.any(Object),
    );
  });
});

test('explicit reload appends a new Provider override from the refreshed model', async () => {
  armStaleReload();
  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'solo-model',
        revision: 'rev-1',
        baselineProviderIds: ['kept'],
        providers: [overriddenProvider('kept', 10, 1000)],
      }),
    ],
  };

  render(<RoutingPage />);
  openSoloModelEditor();
  fireEvent.click(screen.getByTestId('routing-reset-kept'));
  fireEvent.click(screen.getByTestId('routing-save'));
  expect(await screen.findByRole('button', { name: /Reload|再読|다시|重新|重新/u })).toBeInTheDocument();

  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'solo-model',
        revision: 'rev-2',
        baselineProviderIds: ['kept', 'added'],
        providers: [overriddenProvider('kept', 10, 1000), overriddenProvider('added', 30, 4000)],
      }),
    ],
  };
  await reloadEditor();

  expect(screen.queryByTestId('routing-reset-kept')).not.toBeInTheDocument();
  expect(screen.getByTestId('routing-provider-added')).toBeInTheDocument();
  expect(screen.getByTestId('routing-reset-added')).toBeInTheDocument();

  mocks.mutate.mockClear();
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'solo-model',
        revision: 'rev-2',
        baselineProviderIds: ['kept', 'added'],
        providers: {
          kept: {},
          added: { priority: 30, weight: 4000 },
        },
      },
      expect.any(Object),
    );
  });
});

test('explicit reload drops a disappeared Provider from the visible Save payload', async () => {
  armStaleReload();
  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'solo-model',
        revision: 'rev-1',
        baselineProviderIds: ['kept', 'gone'],
        providers: [overriddenProvider('kept', 10, 1000), overriddenProvider('gone', 20, 50)],
      }),
    ],
  };

  render(<RoutingPage />);
  openSoloModelEditor();
  fireEvent.click(screen.getByTestId('routing-reset-kept'));
  fireEvent.click(screen.getByTestId('routing-save'));
  expect(await screen.findByRole('button', { name: /Reload|再読|다시|重新|重新/u })).toBeInTheDocument();
  expect(screen.getByTestId('routing-provider-gone')).toBeInTheDocument();

  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'solo-model',
        revision: 'rev-2',
        baselineProviderIds: ['kept'],
        providers: [overriddenProvider('kept', 10, 1000)],
      }),
    ],
  };
  await reloadEditor();

  expect(screen.queryByTestId('routing-reset-kept')).not.toBeInTheDocument();
  expect(screen.queryByTestId('routing-provider-gone')).not.toBeInTheDocument();

  mocks.mutate.mockClear();
  fireEvent.click(screen.getByTestId('routing-save'));

  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'solo-model',
        revision: 'rev-2',
        baselineProviderIds: ['kept'],
        providers: { kept: {} },
      },
      expect.any(Object),
    );
  });
  expect(mocks.mutate.mock.calls[0]?.[0]).not.toEqual(
    expect.objectContaining({ providers: expect.objectContaining({ gone: expect.anything() }) }),
  );
});

const deferRefetch = () => {
  let resolveRefetch!: (value: { data: DashboardRoutingModelsResponse | undefined }) => void;
  const pending = new Promise<{ data: DashboardRoutingModelsResponse | undefined }>((resolve) => {
    resolveRefetch = resolve;
  });
  mocks.query.refetch.mockImplementation(() => pending);
  return () => resolveRefetch({ data: mocks.query.data });
};

test('pending Reload does not reopen the editor after it is closed', async () => {
  mocks.mutate.mockImplementation((_body: unknown, callbacks?: { onError?: (error: Error) => void }) => {
    const error = Object.assign(new Error('stale routing model'), { code: 'stale_revision' });
    mocks.mutationError = error;
    callbacks?.onError?.(error);
  });
  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'model-a',
        revision: 'rev-1',
        baselineProviderIds: ['a-provider'],
        providers: [provider({ id: 'a-provider' })],
      }),
    ],
  };
  const resolveRefetch = deferRefetch();

  render(<RoutingPage />);
  fireEvent.click(
    within(screen.getByTestId('routing-row-model-a')).getByRole('button', { name: /Edit|編集|편집|编辑|編輯/u }),
  );
  fireEvent.click(screen.getByTestId('routing-save'));
  expect(await screen.findByRole('button', { name: /Reload|再読|다시|重新|重新/u })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Reload|再読|다시|重新|重新/u }));
  fireEvent.click(screen.getByRole('button', { name: /Cancel|キャンセル|취소|取消/u }));
  expect(screen.queryByTestId('routing-editor-drawer')).not.toBeInTheDocument();

  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'model-a',
        revision: 'rev-2',
        baselineProviderIds: ['a-provider'],
        providers: [provider({ id: 'a-provider' })],
      }),
    ],
  };
  await act(async () => {
    resolveRefetch();
  });

  expect(screen.queryByTestId('routing-editor-drawer')).not.toBeInTheDocument();
});

test('pending Reload for one model does not replace another open editor draft', async () => {
  mocks.mutate.mockImplementation((_body: unknown, callbacks?: { onError?: (error: Error) => void }) => {
    const error = Object.assign(new Error('stale routing model'), { code: 'stale_revision' });
    mocks.mutationError = error;
    callbacks?.onError?.(error);
  });
  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'model-a',
        revision: 'rev-a-1',
        baselineProviderIds: ['a-provider'],
        providers: [overriddenProvider('a-provider', 10, 1000)],
      }),
      model({
        modelId: 'model-b',
        revision: 'rev-b-1',
        baselineProviderIds: ['b-provider'],
        providers: [overriddenProvider('b-provider', 20, 2000)],
      }),
    ],
  };
  const resolveRefetch = deferRefetch();

  render(<RoutingPage />);
  fireEvent.click(
    within(screen.getByTestId('routing-row-model-a')).getByRole('button', { name: /Edit|編集|편집|编辑|編輯/u }),
  );
  fireEvent.click(screen.getByTestId('routing-save'));
  expect(await screen.findByRole('button', { name: /Reload|再読|다시|重新|重新/u })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Reload|再読|다시|重新|重新/u }));

  fireEvent.click(
    within(screen.getByTestId('routing-row-model-b')).getByRole('button', {
      hidden: true,
      name: /Edit|編集|편집|编辑|編輯/u,
    }),
  );
  expect(screen.getByTestId('routing-reset-b-provider')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('routing-reset-b-provider'));

  mocks.query.data = {
    writable: true,
    models: [
      model({
        modelId: 'model-a',
        revision: 'rev-a-2',
        baselineProviderIds: ['a-provider', 'added'],
        providers: [overriddenProvider('a-provider', 10, 1000), overriddenProvider('added', 30, 4000)],
      }),
      model({
        modelId: 'model-b',
        revision: 'rev-b-1',
        baselineProviderIds: ['b-provider'],
        providers: [overriddenProvider('b-provider', 20, 2000)],
      }),
    ],
  };
  await act(async () => {
    resolveRefetch();
  });

  expect(screen.queryByTestId('routing-reset-b-provider')).not.toBeInTheDocument();
  expect(screen.queryByTestId('routing-provider-a-provider')).not.toBeInTheDocument();
  expect(screen.queryByTestId('routing-provider-added')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('routing-save'));
  await waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: 'model-b',
        revision: 'rev-b-1',
        baselineProviderIds: ['b-provider'],
        providers: { 'b-provider': {} },
      },
      expect.any(Object),
    );
  });
});

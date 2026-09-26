import type { DashboardRoutingModel } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { useRoutingModelEditor } from '.';

const mocks = rs.hoisted(() => ({
  mutate: rs.fn(),
  reset: rs.fn(),
  shouldBlock: undefined as (() => boolean) | undefined,
  enableBeforeUnload: undefined as (() => boolean) | undefined,
  mutationError: null as Error | null,
  callbacks: undefined as { onError?: (error: Error) => void; onSuccess?: () => void } | undefined,
}));

rs.mock('@tanstack/react-router', () => ({
  useBlocker: (options: { shouldBlockFn: () => boolean; enableBeforeUnload?: () => boolean }) => {
    mocks.shouldBlock = options.shouldBlockFn;
    mocks.enableBeforeUnload = options.enableBeforeUnload;
  },
}));

rs.mock('../use-routing-mutation', () => ({
  useRoutingMutation: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: mocks.mutationError,
    reset: mocks.reset,
  }),
}));

const anthropicProvider = {
  id: 'anthropic',
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' as const },
  defaults: {
    priority: { effective: 0, wasNormalized: false },
    weight: { effective: 1, wasNormalized: false },
  },
  effective: {
    priority: 0,
    weight: 1,
    prioritySource: 'provider' as const,
    weightSource: 'provider' as const,
    eligible: true,
    share: 1,
  },
};

const openaiProvider = {
  id: 'openai',
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' as const },
  defaults: {
    priority: { effective: 0, wasNormalized: false },
    weight: { effective: 1, wasNormalized: false },
  },
  effective: {
    priority: 0,
    weight: 1,
    prioritySource: 'provider' as const,
    weightSource: 'provider' as const,
    eligible: true,
    share: 0.5,
  },
};

const model = (modelId = 'sonnet'): DashboardRoutingModel => ({
  modelId,
  revision: 'rev-1',
  baselineProviderIds: ['anthropic'],
  providerCount: 1,
  eligibleProviderCount: 1,
  hasOverrides: false,
  tiers: [{ priority: 0, providers: [{ providerId: 'anthropic', weight: 1, share: 1 }] }],
  providers: [anthropicProvider],
});

const modelWithOpenai = (modelId = 'sonnet'): DashboardRoutingModel => ({
  ...model(modelId),
  providerCount: 2,
  eligibleProviderCount: 2,
  tiers: [
    {
      priority: 0,
      providers: [
        { providerId: 'anthropic', weight: 1, share: 0.5 },
        { providerId: 'openai', weight: 1, share: 0.5 },
      ],
    },
  ],
  providers: [anthropicProvider, openaiProvider],
});

const renderEditor = (
  options: {
    readonly writable?: boolean;
    readonly model?: DashboardRoutingModel;
    readonly onReload?: () => void | Promise<DashboardRoutingModel | null | undefined>;
  } = {},
) => {
  mocks.mutate.mockImplementation(
    (_body: unknown, callbacks?: { onError?: (error: Error) => void; onSuccess?: () => void }) => {
      mocks.callbacks = callbacks;
    },
  );
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const onReload = options.onReload ?? rs.fn();
  const initialModel = options.model ?? model();
  return {
    ...renderHook(
      (props: { model: DashboardRoutingModel }) =>
        useRoutingModelEditor({
          model: props.model,
          writable: options.writable ?? true,
          onReload,
        }),
      { wrapper, initialProps: { model: initialModel } },
    ),
    mutate: mocks.mutate,
    rejectWithStale: () =>
      mocks.callbacks?.onError?.(Object.assign(new Error('stale routing model'), { code: 'stale_revision' })),
  };
};

const blockerEnabledFor = () => mocks.shouldBlock?.() ?? false;
const beforeUnloadEnabledFor = () => mocks.enableBeforeUnload?.() ?? false;

afterEach(() => {
  mocks.mutate.mockReset();
  mocks.reset.mockReset();
  mocks.shouldBlock = undefined;
  mocks.enableBeforeUnload = undefined;
  mocks.mutationError = null;
  mocks.callbacks = undefined;
});

test('reports which tab is dirty rather than one global flag', () => {
  const { result } = renderEditor();

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));

  expect(result.current.dirtyTabs).toEqual(['topology']);
});

test('tracks the metadata form separately from the topology form', () => {
  const { result } = renderEditor();

  act(() => result.current.metadataForm.setFieldValue('metadata', { touched: true, value: { name: 'x' } }));
  expect(result.current.dirtyTabs).toEqual(['metadata']);

  act(() => result.current.metadataForm.reset());
  act(() =>
    result.current.metadataForm.setFieldValue('overrides', {
      anthropic: {
        cost: { touched: true, value: { input: 1 } },
        limit: { touched: false, value: undefined },
      },
    }),
  );
  expect(result.current.dirtyTabs).toEqual(['cost']);
});

test('blocks navigation while any tab is dirty and allows it when clean', () => {
  const { result } = renderEditor();
  expect(typeof mocks.enableBeforeUnload).toBe('function');
  expect(blockerEnabledFor()).toBe(false);
  expect(beforeUnloadEnabledFor()).toBe(false);

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));

  expect(blockerEnabledFor()).toBe(true);
  expect(beforeUnloadEnabledFor()).toBe(true);
});

test('refuses to save while the metadata draft is invalid', () => {
  const { result, mutate } = renderEditor();

  act(() => result.current.setMetadataValid(false));
  act(() => result.current.form.setFieldValue('providers[0].weight', 3));

  expect(result.current.canSave).toBe(false);
  act(() => result.current.save());
  expect(mutate).not.toHaveBeenCalled();
});

test('refuses to save when the config is read-only', () => {
  const { result } = renderEditor({ writable: false });

  expect(result.current.canSave).toBe(false);
});

test('submits one mutation carrying both forms', async () => {
  const { result, mutate } = renderEditor();

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));
  await act(() => result.current.save());

  expect(mutate).toHaveBeenCalledTimes(1);
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ modelId: 'sonnet', revision: 'rev-1' });
});

test('surfaces a stale revision as a reloadable state rather than a generic failure', async () => {
  const { result, rejectWithStale } = renderEditor();

  await act(() => result.current.save());
  act(() => rejectWithStale());

  expect(result.current.stale).toBe(true);
  expect(result.current.saveFailed).toBe(false);
});

test('returns to clean after a successful save without discarding edited values', async () => {
  const { result, mutate } = renderEditor();

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));
  act(() => result.current.metadataForm.setFieldValue('metadata', { touched: true, value: { name: 'kept' } }));

  await act(() => result.current.save());
  act(() => mocks.callbacks?.onSuccess?.());
  expect(result.current.dirtyTabs).toEqual([]);
  expect(result.current.form.state.values.providers[0]?.weight).toBe(3);
  expect(result.current.form.state.isDirty).toBe(false);
  expect(result.current.metadataForm.state.values.metadata).toEqual({ touched: false, value: { name: 'kept' } });
  expect(blockerEnabledFor()).toBe(false);
  expect(beforeUnloadEnabledFor()).toBe(false);
  expect(mocks.reset).toHaveBeenCalled();

  act(() => result.current.form.setFieldValue('providers[0].weight', 5));
  mutate.mockClear();
  await act(() => result.current.save());

  expect(mutate).toHaveBeenCalledTimes(1);
  expect(mutate.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
});

test('keeps saved values when rerendered with an equivalent model object', async () => {
  const { result, rerender } = renderEditor();

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));
  await act(() => result.current.save());
  act(() => mocks.callbacks?.onSuccess?.());

  rerender({ model: model() });

  expect(result.current.form.state.values.providers[0]?.weight).toBe(3);
});

test('ignores a second synchronous save while the first submit is in flight', async () => {
  const { result, mutate } = renderEditor();

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));
  await act(async () => {
    result.current.save();
    result.current.save();
  });

  expect(mutate).toHaveBeenCalledTimes(1);
});

test('surfaces non-stale mutation errors as save failures', () => {
  mocks.mutationError = new Error('network');
  const initial = model();
  const { result, rerender } = renderEditor({ model: initial });

  rerender({ model: initial });
  expect(result.current.saveFailed).toBe(true);

  mocks.mutationError = Object.assign(new Error('stale routing model'), { code: 'stale_revision' });
  rerender({ model: initial });
  expect(result.current.saveFailed).toBe(false);
});

test('reload merges new provider rows when the mounted model id is unchanged', async () => {
  let resolveReload!: (value: DashboardRoutingModel) => void;
  const reloadPromise = new Promise<DashboardRoutingModel>((resolve) => {
    resolveReload = resolve;
  });
  const onReload = rs.fn().mockReturnValue(reloadPromise);
  const { result, rerender } = renderEditor({ onReload });

  act(() => {
    result.current.reload();
  });
  rerender({ model: model() });

  await act(async () => {
    resolveReload(modelWithOpenai());
  });

  const providerIds = result.current.form.state.values.providers.map((row) => row.providerId);
  expect(providerIds).toContain('openai');
});

test('reload drops a late payload when the mounted model id has changed', async () => {
  let resolveReload!: (value: DashboardRoutingModel) => void;
  const reloadPromise = new Promise<DashboardRoutingModel>((resolve) => {
    resolveReload = resolve;
  });
  const onReload = rs.fn().mockReturnValue(reloadPromise);
  const { result, rerender } = renderEditor({ onReload });

  act(() => {
    result.current.reload();
  });
  rerender({ model: model('gpt') });

  await act(async () => {
    resolveReload(modelWithOpenai('sonnet'));
  });

  const providerIds = result.current.form.state.values.providers.map((row) => row.providerId);
  expect(providerIds).not.toContain('openai');
});

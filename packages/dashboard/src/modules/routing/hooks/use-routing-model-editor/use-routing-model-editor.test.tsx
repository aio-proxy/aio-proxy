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
  callbacks: undefined as { onError?: (error: Error) => void; onSuccess?: () => void } | undefined,
}));

rs.mock('@tanstack/react-router', () => ({
  useBlocker: ({ shouldBlockFn }: { shouldBlockFn: () => boolean }) => {
    mocks.shouldBlock = shouldBlockFn;
  },
}));

rs.mock('../use-routing-mutation', () => ({
  useRoutingMutation: () => ({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
    reset: mocks.reset,
  }),
}));

const model = (): DashboardRoutingModel => ({
  modelId: 'sonnet',
  revision: 'rev-1',
  baselineProviderIds: ['anthropic'],
  providerCount: 1,
  eligibleProviderCount: 1,
  hasOverrides: false,
  tiers: [{ priority: 0, providers: [{ providerId: 'anthropic', weight: 1, share: 1 }] }],
  providers: [
    {
      id: 'anthropic',
      kind: ProviderKind.Api,
      enabled: true,
      state: { status: 'ready' },
      defaults: {
        priority: { effective: 0, wasNormalized: false },
        weight: { effective: 1, wasNormalized: false },
      },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 1,
      },
    },
  ],
});

const renderEditor = (options: { readonly writable?: boolean } = {}) => {
  mocks.mutate.mockImplementation(
    (_body: unknown, callbacks?: { onError?: (error: Error) => void; onSuccess?: () => void }) => {
      mocks.callbacks = callbacks;
    },
  );
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return {
    ...renderHook(
      () =>
        useRoutingModelEditor({
          model: model(),
          writable: options.writable ?? true,
          onReload: rs.fn(),
        }),
      { wrapper },
    ),
    mutate: mocks.mutate,
    rejectWithStale: () =>
      mocks.callbacks?.onError?.(Object.assign(new Error('stale routing model'), { code: 'stale_revision' })),
  };
};

const blockerEnabledFor = () => mocks.shouldBlock?.() ?? false;

afterEach(() => {
  mocks.mutate.mockReset();
  mocks.reset.mockReset();
  mocks.shouldBlock = undefined;
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
  expect(blockerEnabledFor()).toBe(false);

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));

  expect(blockerEnabledFor()).toBe(true);
});

test('refuses to save while the metadata draft is invalid', () => {
  const { result } = renderEditor();

  act(() => result.current.setMetadataValid(false));

  expect(result.current.canSave).toBe(false);
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

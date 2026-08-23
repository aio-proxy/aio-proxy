import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { useProviderEditorForm } from '../use-provider-editor-form';
import { useProviderCatalogMutation } from './use-provider-catalog-mutation';

const mocks = rs.hoisted(() => ({ fetchCatalog: rs.fn() }));

rs.mock('../../services/provider-draft', () => ({
  fetchProviderDraftCatalog: mocks.fetchCatalog,
}));

beforeEach(() => mocks.fetchCatalog.mockReset());

test('loads a validated Provider catalogue only after the mutation is triggered', async () => {
  const response = { ok: true, models: ['catalog-a'] } as const;
  mocks.fetchCatalog.mockResolvedValue(response);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(
    () => {
      const form = useProviderEditorForm({
        kind: ProviderKind.Api,
        initial: {
          kind: ProviderKind.Api,
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
        },
      });
      return useProviderCatalogMutation(form, 'provider');
    },
    { wrapper },
  );

  expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  act(() => result.current.mutate());

  await waitFor(() => expect(result.current.data).toEqual(response));
  expect(mocks.fetchCatalog).toHaveBeenCalledWith({
    draft: expect.objectContaining({
      kind: ProviderKind.Api,
      id: 'provider',
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.example/v1',
    }),
    persistedProviderId: 'provider',
  });
});

test('does not treat editor alias rows as an invalid draft', async () => {
  const response = { ok: true, models: ['catalog-a'] } as const;
  mocks.fetchCatalog.mockResolvedValue(response);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(
    () => {
      const form = useProviderEditorForm({
        kind: ProviderKind.Api,
        initial: {
          kind: ProviderKind.Api,
          id: 'provider',
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://api.example/v1',
          alias: { default: { model: 'gpt-5', preserve: false } },
        },
      });
      return useProviderCatalogMutation(form, 'provider');
    },
    { wrapper },
  );

  act(() => result.current.mutate());

  await waitFor(() => expect(result.current.data).toEqual(response));
  expect(mocks.fetchCatalog).toHaveBeenCalled();
});

test('an ai-sdk draft with leftover api fields and alias rows still fetches the catalog', async () => {
  const response = { ok: true, models: ['catalog-a'] } as const;
  mocks.fetchCatalog.mockResolvedValue(response);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(
    () => {
      const form = useProviderEditorForm({
        kind: ProviderKind.AiSdk,
        initial: {
          kind: ProviderKind.AiSdk,
          id: 'provider',
          packageName: '@ai-sdk/openai-compatible',
          options: { baseURL: 'https://api.example/v1', apiKey: 'sk-test' },
          alias: { default: { model: 'gpt-5', preserve: false } },
        },
      });
      form.setFieldValue('endpoints', {
        shape: 'shared',
        baseURL: 'https://api.example/v1',
        protocols: [ProviderProtocol.OpenAICompatible],
      });
      form.setFieldValue('protocol', ProviderProtocol.OpenAICompatible);
      form.setFieldValue('baseURL', 'https://api.example/v1');
      form.setFieldValue('headers', { Authorization: 'Bearer leftover' });
      return useProviderCatalogMutation(form);
    },
    { wrapper },
  );

  act(() => result.current.mutate());

  await waitFor(() => expect(result.current.data).toEqual(response));
  expect(mocks.fetchCatalog).toHaveBeenCalled();
});

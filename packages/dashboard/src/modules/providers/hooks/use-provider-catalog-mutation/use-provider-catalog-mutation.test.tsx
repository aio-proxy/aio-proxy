import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { beforeEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { ProviderFormMode } from '../../constants';
import { useProviderForm } from '../use-provider-form';
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
      const form = useProviderForm({
        mode: ProviderFormMode.Edit,
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

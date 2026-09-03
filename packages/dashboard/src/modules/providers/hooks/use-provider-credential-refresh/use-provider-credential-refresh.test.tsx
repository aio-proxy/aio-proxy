import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { useProviderCredentialRefresh } from './use-provider-credential-refresh';

const mocks = rs.hoisted(() => ({ refreshProviderCredential: rs.fn(), toastAdd: rs.fn() }));

rs.mock('../../services/provider-credential-refresh-service', () => ({
  refreshProviderCredential: mocks.refreshProviderCredential,
}));

rs.mock('@aio-proxy/ui/components/toast', () => ({ toast: { add: mocks.toastAdd } }));

rs.mock('@aio-proxy/i18n', () => ({
  m: {
    'dashboard.providers.toast.credential_refreshed': () => 'Credential refreshed',
    'dashboard.providers.toast.credential_refresh_failed': () => 'Failed to refresh credential',
  },
}));

const setup = () => {
  mocks.refreshProviderCredential.mockReset();
  mocks.toastAdd.mockReset();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
};

test('a successful refresh refetches the Provider list and announces it', async () => {
  const wrapper = setup();
  mocks.refreshProviderCredential.mockResolvedValue(undefined);
  let refetches = 0;
  // The Provider list is rendered alongside the hook because invalidation only refetches keys an
  // observer is watching; an unobserved cache entry would stay quiet and let a missing invalidation pass.
  const { result } = renderHook(
    () => ({
      refresh: useProviderCredentialRefresh(),
      list: useQuery({
        queryKey: queryKeys.providers,
        queryFn: () => {
          refetches += 1;
          return Promise.resolve({ providers: [] });
        },
      }),
    }),
    { wrapper },
  );

  await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
  expect(refetches).toBe(1);

  act(() => result.current.refresh.mutate('openai.main'));

  await waitFor(() => expect(result.current.refresh.isSuccess).toBe(true));
  expect(mocks.refreshProviderCredential).toHaveBeenCalledWith('openai.main');
  // The refreshed accountLabel and expiresAt only exist server-side, so the list has to refetch.
  await waitFor(() => expect(refetches).toBe(2));
  expect(mocks.toastAdd).toHaveBeenCalledWith({ type: 'success', title: 'Credential refreshed' });
});

test('a failed refresh announces the failure without surfacing the error code', async () => {
  const wrapper = setup();
  mocks.refreshProviderCredential.mockRejectedValue(new Error('OAUTH_CREDENTIAL_REFRESH_FAILED'));
  const { result } = renderHook(() => useProviderCredentialRefresh(), { wrapper });

  act(() => result.current.mutate('openai.main'));

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(mocks.toastAdd).toHaveBeenCalledWith({ type: 'error', title: 'Failed to refresh credential' });
});

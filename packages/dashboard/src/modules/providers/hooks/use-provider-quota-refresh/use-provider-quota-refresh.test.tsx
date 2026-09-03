import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { useProviderQuotaRefresh } from './use-provider-quota-refresh';

const mocks = rs.hoisted(() => ({ getProviderQuota: rs.fn() }));

rs.mock('../../services/provider-quota-service', () => ({
  getProviderQuota: mocks.getProviderQuota,
}));

test('a refresh bypasses the cooldown and seeds the shared passive cache entry', async () => {
  const entry = {
    snapshot: { items: [{ id: 'week', displayName: 'Week', remainingRatio: 0.5 }] },
    sampledAt: 2,
    stale: false,
  };
  mocks.getProviderQuota.mockReset();
  mocks.getProviderQuota.mockResolvedValue(entry);
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => useProviderQuotaRefresh('openai.main'), { wrapper });

  expect(mocks.getProviderQuota).not.toHaveBeenCalled();
  act(() => result.current.mutate());

  await waitFor(() => expect(result.current.data).toEqual(entry));
  expect(mocks.getProviderQuota).toHaveBeenCalledWith('openai.main', true);
  // The ring reads the passive key, so the refreshed reading has to land there for both to agree.
  expect(queryClient.getQueryData(queryKeys.providerQuota('openai.main'))).toEqual(entry);
});

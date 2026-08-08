import type { DashboardProvidersResponse } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { useProviderEnabledMutation } from '.';

const mocks = rs.hoisted(() => ({ update: rs.fn() }));

rs.mock('../../services/providers-service', () => ({
  updateProviderEnabledMutationFn: mocks.update,
}));

afterEach(() => {
  rs.restoreAllMocks();
});

test('optimistically updates enabled, rolls back on failure, and invalidates providers', async () => {
  let rejectMutation: (error: Error) => void = () => {};
  mocks.update.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectMutation = reject;
      }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const initial: DashboardProvidersResponse = {
    providers: [
      {
        id: 'openai-main',
        kind: 'api',
        enabled: true,
        passthrough: true,
        last_status: 'unknown',
        last_latency: null,
        clientModels: [],
        state: { status: 'ready' },
      },
    ],
  };
  queryClient.setQueryData(['providers'], initial);
  const invalidate = rs.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => useProviderEnabledMutation(), { wrapper });

  act(() => result.current.mutate({ id: 'openai-main', enabled: false }));

  await waitFor(() => {
    expect(queryClient.getQueryData<DashboardProvidersResponse>(['providers'])?.providers[0]?.enabled).toBe(false);
  });

  act(() => rejectMutation(new Error('request failed')));

  await waitFor(() => {
    expect(queryClient.getQueryData(['providers'])).toEqual(initial);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['providers'] });
  });
});

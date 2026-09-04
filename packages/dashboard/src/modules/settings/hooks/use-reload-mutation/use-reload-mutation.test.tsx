import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import { queryKeys } from '@/lib/query-keys';

import { useReloadMutation } from './use-reload-mutation';

const mocks = rs.hoisted(() => ({ reloadConfigMutationFn: rs.fn() }));

rs.mock('../../services/reload-service', () => ({
  reloadConfigMutationFn: mocks.reloadConfigMutationFn,
}));

const renderReloadMutation = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateQueries = rs.spyOn(queryClient, 'invalidateQueries');
  const view = renderHook(() => useReloadMutation(), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  return { invalidateQueries, result: view.result };
};

test('refreshes settings and providers after a successful reload', async () => {
  mocks.reloadConfigMutationFn.mockReset().mockResolvedValue({ providerIds: { added: [], removed: [] } });
  const { invalidateQueries, result } = renderReloadMutation();

  result.current.mutate();

  await waitFor(() => {
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.providers });
  });
});

test('refreshes every config-backed query after a successful reload', async () => {
  mocks.reloadConfigMutationFn.mockReset().mockResolvedValue({ providerIds: { added: [], removed: [] } });
  const { invalidateQueries, result } = renderReloadMutation();

  result.current.mutate();

  // A reload commits the whole config snapshot, so routing and plugin caches go stale too.
  await waitFor(() => {
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.plugins });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.routingModels });
    // A reload can add or drop OAuth-capable plugins and rewrite the overview's provider set.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.oauthCapabilities });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.overview });
  });
});

test('the overview invalidation key is a prefix of every range-scoped overview query', () => {
  for (const key of [queryKeys.overviewActivity, queryKeys.overviewRange('7d'), queryKeys.overviewDiagnostics('7d')]) {
    expect(key.slice(0, queryKeys.overview.length)).toEqual([...queryKeys.overview]);
  }
});

test('does not refresh anything when the reload is rejected', async () => {
  mocks.reloadConfigMutationFn.mockReset().mockRejectedValue(new Error('providers'));
  const { invalidateQueries, result } = renderReloadMutation();

  result.current.mutate();

  await waitFor(() => {
    expect(result.current.isError).toBe(true);
  });
  expect(invalidateQueries).not.toHaveBeenCalled();
});

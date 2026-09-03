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

test('does not refresh anything when the reload is rejected', async () => {
  mocks.reloadConfigMutationFn.mockReset().mockRejectedValue(new Error('providers'));
  const { invalidateQueries, result } = renderReloadMutation();

  result.current.mutate();

  await waitFor(() => {
    expect(result.current.isError).toBe(true);
  });
  expect(invalidateQueries).not.toHaveBeenCalled();
});

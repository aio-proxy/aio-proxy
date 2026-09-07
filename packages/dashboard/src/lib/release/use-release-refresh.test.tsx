import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { useReleaseRefresh } from './use-release-refresh';

const mocks = rs.hoisted(() => ({
  check: rs.fn(),
  releaseQueryFn: rs.fn(),
}));

rs.mock('./release-service', () => ({
  checkLatestReleaseMutationFn: mocks.check,
  releaseQueryOptions: () => ({
    queryKey: queryKeys.release,
    queryFn: mocks.releaseQueryFn,
  }),
}));

const renderRefresh = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const invalidateQueries = rs.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidateQueries, ...renderHook(() => useReleaseRefresh(), { wrapper }) };
};

test('loads GET /release and refreshes after a successful mount-time latest check', async () => {
  mocks.check.mockReset().mockResolvedValue({ current: '1.4.2', latest: '1.10.0', outdated: true });
  mocks.releaseQueryFn.mockReset().mockResolvedValue({
    current: '1.4.2',
    latest: '1.10.0',
    outdated: true,
    managedService: false,
    update: { status: 'idle' },
  });
  const { invalidateQueries } = renderRefresh();

  await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.release }));
});

test('keeps the last good GET /release when the mount-time latest check fails', async () => {
  mocks.check.mockReset().mockRejectedValue(new Error('check_failed'));
  mocks.releaseQueryFn.mockReset().mockResolvedValue({
    current: '1.4.2',
    outdated: false,
    managedService: false,
    update: { status: 'idle' },
  });
  const { invalidateQueries } = renderRefresh();

  await waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
  expect(invalidateQueries).not.toHaveBeenCalled();
});

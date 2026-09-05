import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { useProviderQuotaReset } from './use-provider-quota-reset';

const mocks = rs.hoisted(() => ({ resetProviderQuota: rs.fn(), toastAdd: rs.fn() }));

rs.mock('../../services/provider-quota-reset-service', () => ({
  resetProviderQuota: mocks.resetProviderQuota,
  QUOTA_RESET_UNAVAILABLE_STATUS: 409,
  DashboardProviderQuotaResetError: class extends Error {
    constructor(readonly status: number) {
      super(`failed with ${status}`);
    }
  },
}));

rs.mock('@aio-proxy/ui/components/toast', () => ({ toast: { add: mocks.toastAdd } }));

rs.mock('@aio-proxy/i18n', () => ({
  m: {
    'dashboard.providers.quota.reset_succeeded': () => 'Reset credit redeemed',
    'dashboard.providers.quota.reset_failed': () => 'The reset credit could not be redeemed',
    'dashboard.providers.quota.reset_unavailable': () => 'No reset credit is available anymore',
  },
}));

const setup = () => {
  mocks.resetProviderQuota.mockReset();
  mocks.toastAdd.mockReset();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
};

/**
 * Redemption is irreversible, so the window between "the request succeeded" and "the new count is on
 * screen" is the dangerous one: while it is open the button still renders the pre-reset count, and the
 * server's own preflight would agree there is a credit left and spend a second one.
 */
test('stays pending until the post-reset reading replaces the stale count', async () => {
  const wrapper = setup();
  mocks.resetProviderQuota.mockResolvedValue(undefined);
  const refetched = Promise.withResolvers<{ readonly resetCredits: { readonly availableCount: number } }>();
  let reads = 0;
  const { result } = renderHook(
    () => ({
      reset: useProviderQuotaReset('openai.main'),
      quota: useQuery({
        queryKey: queryKeys.providerQuota('openai.main'),
        queryFn: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve({ resetCredits: { availableCount: 2 } }) : refetched.promise;
        },
      }),
    }),
    { wrapper },
  );

  await waitFor(() => expect(result.current.quota.isSuccess).toBe(true));
  act(() => result.current.reset.mutate());
  await waitFor(() => expect(reads).toBe(2));

  // The redemption itself has settled and the refetch is in flight. Were the invalidation discarded,
  // the mutation would already be idle here and the confirm button re-enabled over the old count.
  expect(mocks.resetProviderQuota).toHaveBeenCalledTimes(1);
  expect(result.current.reset.isPending).toBe(true);

  refetched.resolve({ resetCredits: { availableCount: 1 } });
  await waitFor(() => expect(result.current.reset.isPending).toBe(false));
  expect(result.current.quota.data).toEqual({ resetCredits: { availableCount: 1 } });
  expect(mocks.toastAdd).toHaveBeenCalledWith({ type: 'success', title: 'Reset credit redeemed' });
});

/**
 * The only caller lives inside the quota popup, so closing it unmounts the observer while the request is
 * still running. A remounted `useMutation` reports idle, and against the cached nonzero count that
 * re-offers the confirmation — the server's FIFO would then spend a second credit. The pending state has
 * to come from the mutation cache, which outlives the popup.
 */
test('a redemption stays pending across a popup that closed and reopened', async () => {
  const wrapper = setup();
  const request = Promise.withResolvers<undefined>();
  mocks.resetProviderQuota.mockReturnValue(request.promise);

  const first = renderHook(() => useProviderQuotaReset('openai.main'), { wrapper });
  act(() => first.result.current.mutate());
  await waitFor(() => expect(first.result.current.isPending).toBe(true));

  // Closing the popup unmounts this observer; reopening mounts a brand new one.
  first.unmount();
  const reopened = renderHook(() => useProviderQuotaReset('openai.main'), { wrapper });

  expect(reopened.result.current.isPending).toBe(true);

  request.resolve(undefined);
  await waitFor(() => expect(reopened.result.current.isPending).toBe(false));
  expect(mocks.resetProviderQuota).toHaveBeenCalledTimes(1);
});

test('a failed redemption still refetches the reading the button was rendered from', async () => {
  const wrapper = setup();
  mocks.resetProviderQuota.mockRejectedValue(new Error('OAUTH_QUOTA_RESET_FAILED'));
  let reads = 0;
  const { result } = renderHook(
    () => ({
      reset: useProviderQuotaReset('openai.main'),
      quota: useQuery({
        queryKey: queryKeys.providerQuota('openai.main'),
        queryFn: () => {
          reads += 1;
          return Promise.resolve({ resetCredits: { availableCount: 2 } });
        },
      }),
    }),
    { wrapper },
  );

  await waitFor(() => expect(result.current.quota.isSuccess).toBe(true));
  expect(reads).toBe(1);

  act(() => result.current.reset.mutate());

  await waitFor(() => expect(result.current.reset.isError).toBe(true));
  await waitFor(() => expect(reads).toBe(2));
  expect(mocks.toastAdd).toHaveBeenCalledWith({
    type: 'error',
    title: 'The reset credit could not be redeemed',
  });
});

import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useProviderDetach } from './use-provider-detach';

const mocks = rs.hoisted(() => ({ detachSync: rs.fn(), cancelDetachSync: rs.fn() }));

rs.mock('@/modules/settings/services/sync-service', () => ({
  detachSync: mocks.detachSync,
  cancelDetachSync: mocks.cancelDetachSync,
}));

// The mutation function is invoked with a React Query context argument after the variables, which is
// none of this hook's business — only the payload it sent is.
const detachCalls = () => mocks.detachSync.mock.calls.map(([input]) => input);

const status = { state: 'idle', providers: [], backends: [] };

const renderDetach = () => {
  mocks.detachSync.mockReset().mockResolvedValue(status);
  mocks.cancelDetachSync.mockReset().mockResolvedValue(status);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useProviderDetach('work'), { wrapper });
};

// The first call is what marks the Provider `detach-pending`, so the login that follows is not
// published as the shared credential; sending only the second call leaves the Provider shared and
// the request refused, which is the state this pins against.
test('detaching marks the Provider pending, asks for a login, then names that login as proof', async () => {
  const startLogin = rs.fn(() => true);
  const { result } = renderDetach();

  await result.current.start(startLogin);

  expect(detachCalls()).toEqual([{ providerId: 'work' }]);
  expect(startLogin).toHaveBeenCalledTimes(1);

  result.current.complete('login-session');

  await waitFor(() => expect(mocks.detachSync).toHaveBeenCalledTimes(2));
  expect(detachCalls()[1]).toEqual({ providerId: 'work', loginSessionId: 'login-session' });
});

// Re-authorizing for any other reason must not finish a detachment nobody asked for: the second call
// is what makes the local credential independent of the cloud copy.
test('a login nobody detached for is not turned into a detachment', async () => {
  const { result } = renderDetach();

  result.current.complete('login-session');

  await waitFor(() => expect(mocks.detachSync).not.toHaveBeenCalled());
});

test('one pending detachment is completed once, not by every later login', async () => {
  const { result } = renderDetach();

  await result.current.start(rs.fn(() => true));
  result.current.complete('first-login');
  result.current.complete('second-login');

  await waitFor(() => expect(mocks.detachSync).toHaveBeenCalledTimes(2));
  expect(detachCalls()[1]).toEqual({ providerId: 'work', loginSessionId: 'first-login' });
});

// An editor that refuses the save — an invalid field, a blocking section — starts no OAuth at all.
// Recording the intent anyway reported the detachment as under way and let the next unrelated
// re-authorization finish it.
test('a save that starts no login fails the detach instead of waiting for an unrelated one', async () => {
  const { result } = renderDetach();

  await expect(result.current.start(() => false)).rejects.toThrow();
  result.current.complete('unrelated-login');

  await waitFor(() => expect(detachCalls()).toEqual([{ providerId: 'work' }]));
});

// The same stale intent survived a login that started and then failed or was cancelled.
test('a lost login leaves no detachment for a later one to complete', async () => {
  const { result } = renderDetach();

  await result.current.start(rs.fn(() => true));
  result.current.cancel();
  result.current.complete('later-login');

  await waitFor(() => expect(detachCalls()).toEqual([{ providerId: 'work' }]));
});

// `detach-pending` is server state that blocks every read of the shared credential, so an abandoned
// detachment left the Provider unusable until the user retried or ran the CLI. Both abort paths have
// to release it, not just the hook's own intent.
test.each([
  [
    'a save that starts no login',
    async (start: (login: () => boolean) => Promise<void>, cancel: () => void) => {
      await expect(start(() => false)).rejects.toThrow();
      void cancel;
    },
  ],
  [
    'a login that was lost',
    async (start: (login: () => boolean) => Promise<void>, cancel: () => void) => {
      await start(() => true);
      cancel();
    },
  ],
])('%s releases the pending detachment on the server', async (_name, abort) => {
  const { result } = renderDetach();

  await abort(
    (login) => result.current.start(login),
    () => result.current.cancel(),
  );

  await waitFor(() => expect(mocks.cancelDetachSync).toHaveBeenCalledTimes(1));
  expect(mocks.cancelDetachSync.mock.calls[0]?.[0]).toEqual({ providerId: 'work' });
});

// Cancelling on behalf of a login this hook never started would clear a detachment the user is
// still authorizing for, or one the CLI owns.
test('a lost login nobody detached for cancels nothing on the server', async () => {
  const { result } = renderDetach();

  result.current.cancel();

  await waitFor(() => expect(mocks.cancelDetachSync).not.toHaveBeenCalled());
});

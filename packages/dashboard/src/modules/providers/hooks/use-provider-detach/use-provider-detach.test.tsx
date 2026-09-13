import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useProviderDetach } from './use-provider-detach';

const mocks = rs.hoisted(() => ({ detachSync: rs.fn() }));

rs.mock('@/modules/settings/services/sync-service', () => ({ detachSync: mocks.detachSync }));

// The mutation function is invoked with a React Query context argument after the variables, which is
// none of this hook's business — only the payload it sent is.
const detachCalls = () => mocks.detachSync.mock.calls.map(([input]) => input);

const renderDetach = () => {
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
  mocks.detachSync.mockReset().mockResolvedValue({ state: 'idle', providers: [], backends: [] });
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
  mocks.detachSync.mockReset().mockResolvedValue({ state: 'idle', providers: [], backends: [] });
  const { result } = renderDetach();

  result.current.complete('login-session');

  await waitFor(() => expect(mocks.detachSync).not.toHaveBeenCalled());
});

test('one pending detachment is completed once, not by every later login', async () => {
  mocks.detachSync.mockReset().mockResolvedValue({ state: 'idle', providers: [], backends: [] });
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
  mocks.detachSync.mockReset().mockResolvedValue({ state: 'idle', providers: [], backends: [] });
  const { result } = renderDetach();

  await expect(result.current.start(() => false)).rejects.toThrow();
  result.current.complete('unrelated-login');

  await waitFor(() => expect(detachCalls()).toEqual([{ providerId: 'work' }]));
});

// The same stale intent survived a login that started and then failed or was cancelled.
test('a lost login leaves no detachment for a later one to complete', async () => {
  mocks.detachSync.mockReset().mockResolvedValue({ state: 'idle', providers: [], backends: [] });
  const { result } = renderDetach();

  await result.current.start(rs.fn(() => true));
  result.current.cancel();
  result.current.complete('later-login');

  await waitFor(() => expect(detachCalls()).toEqual([{ providerId: 'work' }]));
});

import { afterEach, beforeEach, expect, rs, test } from '@rstest/core';

import { clearDashboardAuthToken, readDashboardAuthToken } from '@/lib/dashboard-auth-token';
import { queryClient } from '@/lib/query-client';

import { setDashboardAuthSession } from '../auth-session-store';
import { dashboardAuthSessionQueryOptions, loginDashboard, logoutDashboard } from './auth-service';

const mocks = rs.hoisted(() => ({
  login: rs.fn(),
  session: rs.fn(),
  unauthorized: undefined as (() => void) | undefined,
  unavailable: undefined as (() => void) | undefined,
}));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: { api: { auth: { login: { $post: mocks.login }, session: { $get: mocks.session } } } },
  },
  setDashboardUnauthorizedHandler: (handler: () => void) => {
    mocks.unauthorized = handler;
  },
  setDashboardUnavailableHandler: (handler: () => void) => {
    mocks.unavailable = handler;
  },
}));

beforeEach(() => {
  queryClient.clear();
  clearDashboardAuthToken();
  mocks.login.mockReset();
  mocks.session.mockReset();
});

afterEach(() => {
  clearDashboardAuthToken();
});

test('a business API 401 transitions a cached disabled session to unauthenticated', () => {
  setDashboardAuthSession({ status: 'disabled' });

  mocks.unauthorized?.();

  expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'unauthenticated' });
});

test('the session check rides out a server restart instead of failing on the first refused request', async () => {
  // A dev `bun --watch` restart or an auto-update: the connection is refused, then the proxy times
  // out, then the server is back. Failing on the first error parks the page on "Dashboard unavailable".
  mocks.session
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ ok: false, status: 504 })
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'authenticated' }) });

  // Only the backoff is shortened; the retry policy under test is the real one.
  await expect(queryClient.fetchQuery({ ...dashboardAuthSessionQueryOptions(), retryDelay: 0 })).resolves.toEqual({
    status: 'authenticated',
  });
  expect(mocks.session).toHaveBeenCalledTimes(4);
});

test('login 409 transitions the cached session back to disabled', async () => {
  setDashboardAuthSession({ status: 'unauthenticated' });
  mocks.login.mockResolvedValue({ status: 409 });

  await loginDashboard('password');

  expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'disabled' });
});

test('a rejected login request returns the unavailable feedback result', async () => {
  mocks.login.mockRejectedValue(new Error('offline'));

  await expect(loginDashboard('password')).resolves.toEqual({ ok: false, error: 'unknown' });
});

test('a successful login stores the session token and logout clears it', async () => {
  mocks.login.mockResolvedValue(
    Response.json({ ok: true, token: 'dashboard-session-token', expiresAt: '2026-08-18T00:00:00.000Z' }),
  );

  await expect(loginDashboard('password')).resolves.toEqual({ ok: true });
  expect(readDashboardAuthToken()).toBe('dashboard-session-token');
  expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'authenticated' });

  await logoutDashboard();

  expect(readDashboardAuthToken()).toBeUndefined();
  expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'unauthenticated' });
});

test('a sibling tab clearing the token logs this tab out without an expiry notice', async () => {
  mocks.login.mockResolvedValue(
    Response.json({ ok: true, token: 'dashboard-session-token', expiresAt: '2026-08-18T00:00:00.000Z' }),
  );
  await loginDashboard('password');

  clearDashboardAuthToken();
  globalThis.dispatchEvent(
    new StorageEvent('storage', { key: 'aio-proxy.dashboard-session', newValue: null, storageArea: localStorage }),
  );
  await Promise.resolve();

  expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'unauthenticated' });
});

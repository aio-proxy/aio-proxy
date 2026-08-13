import { afterEach, beforeEach, expect, rs, test } from '@rstest/core';

import { clearDashboardAuthToken, readDashboardAuthToken } from '@/lib/dashboard-auth-token';
import { queryClient } from '@/lib/query-client';

import { setDashboardAuthSession } from '../auth-session-store';
import { loginDashboard, logoutDashboard } from './auth-service';

const mocks = rs.hoisted(() => ({
  login: rs.fn(),
  unauthorized: undefined as (() => void) | undefined,
  unavailable: undefined as (() => void) | undefined,
}));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: { api: { auth: { login: { $post: mocks.login } } } },
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
});

afterEach(() => {
  clearDashboardAuthToken();
});

test('a business API 401 transitions a cached disabled session to unauthenticated', () => {
  setDashboardAuthSession({ status: 'disabled' });

  mocks.unauthorized?.();

  expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'unauthenticated' });
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

import { afterEach, beforeEach, expect, rs, test } from '@rstest/core';

import { clearDashboardAuthToken, writeDashboardAuthToken } from '@/lib/dashboard-auth-token';
import '@/modules/auth/services/auth-service';
import { setDashboardAuthSession } from '@/modules/auth/services/auth-session-store';

import { createDashboardClient } from '.';
import { queryClient } from '../query-client';

beforeEach(() => {
  queryClient.clear();
  clearDashboardAuthToken();
});

afterEach(() => {
  rs.restoreAllMocks();
  clearDashboardAuthToken();
});

test.each(['authenticated', 'disabled'] as const)(
  "dashboard unavailable clears a cached %s session's business queries",
  async (status) => {
    setDashboardAuthSession({ status });
    queryClient.setQueryData(['providers'], { providers: [{ id: 'primary' }] });
    rs.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'dashboard_unavailable' }, { status: 503 }));

    const response = await createDashboardClient('http://localhost').dashboard.api.providers.$get();

    expect(response.status).toBe(503);
    expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'unavailable' });
    expect(queryClient.getQueryData(['providers'])).toBeUndefined();
  },
);

test('attaches a stored Bearer token to Dashboard API requests except login', async () => {
  writeDashboardAuthToken('dashboard-session-token');
  const fetchSpy = rs.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ providers: [] }));

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();
  await createDashboardClient('http://localhost').dashboard.api.auth.login.$post({ json: { password: 'secret' } });

  expect(fetchSpy.mock.calls[0]?.[1]?.headers).toBeInstanceOf(Headers);
  expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer dashboard-session-token');
  expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('authorization')).toBeNull();
});

test.each(['authenticated', 'disabled'] as const)(
  "dashboard unavailable clears a cached %s session's business queries",
  async (status) => {
    setDashboardAuthSession({ status });
    queryClient.setQueryData(['providers'], { providers: [{ id: 'primary' }] });
    rs.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'dashboard_unavailable' }, { status: 503 }));

    const response = await createDashboardClient('http://localhost').dashboard.api.providers.$get();

    expect(response.status).toBe(503);
    expect(queryClient.getQueryData(['dashboard-auth'])).toEqual({ status: 'unavailable' });
    expect(queryClient.getQueryData(['providers'])).toBeUndefined();
  },
);

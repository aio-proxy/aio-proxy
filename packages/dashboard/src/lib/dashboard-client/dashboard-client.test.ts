import { afterEach, beforeEach, expect, rs, test } from '@rstest/core';

import { clearDashboardAuthToken, readDashboardAuthToken, writeDashboardAuthToken } from '@/lib/dashboard-auth-token';
import '@/modules/auth/services/auth-service';
import { setDashboardAuthSession } from '@/modules/auth/services/auth-session-store';

import { createDashboardClient } from '.';
import { queryClient } from '../query-client';
import { queryKeys } from '../query-keys';

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

test('replaces the stored session token when a response carries a renewal', async () => {
  writeDashboardAuthToken('aged-token');
  rs.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { headers: { 'x-dashboard-session-refresh': 'renewed-token' } }),
  );

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();

  expect(readDashboardAuthToken()).toBe('renewed-token');
});

test('an empty renewal header leaves the stored session token untouched', async () => {
  writeDashboardAuthToken('live-token');
  rs.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { headers: { 'x-dashboard-session-refresh': '' } }),
  );

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();

  expect(readDashboardAuthToken()).toBe('live-token');
});

test('a renewal arriving after logout does not resurrect the session', async () => {
  writeDashboardAuthToken('aged-token');
  rs.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    clearDashboardAuthToken();
    return new Response('{}', { headers: { 'x-dashboard-session-refresh': 'renewed-token' } });
  });

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();

  expect(readDashboardAuthToken()).toBeUndefined();
});

test('a stale 401 does not tear down a session another tab has since established', async () => {
  setDashboardAuthSession({ status: 'authenticated' });
  writeDashboardAuthToken('expired-token');
  rs.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    // Stands in for a sibling tab logging in while this request was in flight.
    writeDashboardAuthToken('fresh-token-from-another-tab');
    return new Response('{"error":"authentication_required"}', { status: 401 });
  });

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();

  expect(readDashboardAuthToken()).toBe('fresh-token-from-another-tab');
  expect(queryClient.getQueryData(queryKeys.auth)).toEqual({ status: 'authenticated' });
});

test('a sibling request renewing the same session does not swallow a real 401', async () => {
  const client = createDashboardClient('http://localhost');
  setDashboardAuthSession({ status: 'authenticated' });
  writeDashboardAuthToken('aged-token');
  // One request renews the shared token, so the client knows `renewed-token` as its own renewal.
  rs.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response('{}', { headers: { 'x-dashboard-session-refresh': 'renewed-token' } }),
  );
  await client.dashboard.api.providers.$get();

  // A concurrent request carried the aged token, and the renewal lands before its response does.
  writeDashboardAuthToken('aged-token');
  rs.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    writeDashboardAuthToken('renewed-token');
    return new Response('{"error":"authentication_required"}', { status: 401 });
  });
  await client.dashboard.api.config.$get();

  // Storage no longer holds the token that request sent, but that is this session renewing itself,
  // not a replacement login, so the 401 must still expire the session.
  expect(queryClient.getQueryData(queryKeys.auth)).toEqual({ status: 'unauthenticated', reason: 'expired' });
});

test('a 401 for the session that sent it still expires that session', async () => {
  setDashboardAuthSession({ status: 'authenticated' });
  writeDashboardAuthToken('expired-token');
  rs.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"authentication_required"}', { status: 401 }));

  await createDashboardClient('http://localhost').dashboard.api.providers.$get();

  expect(readDashboardAuthToken()).toBeUndefined();
  expect(queryClient.getQueryData(queryKeys.auth)).toEqual({ status: 'unauthenticated', reason: 'expired' });
});

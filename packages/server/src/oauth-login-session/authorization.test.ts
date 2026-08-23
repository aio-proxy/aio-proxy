import { expect, test } from 'bun:test';

import type { DashboardOAuthSession } from '@aio-proxy/types';

import { createDashboardAuthorization } from './authorization';

test('publishes an authorize_url session when the adapter presents a URL', async () => {
  const published: DashboardOAuthSession[] = [];
  const auth = createDashboardAuthorization({
    sessionId: '00000000-0000-4000-8000-000000000000',
    signal: new AbortController().signal,
    publish: (session) => published.push(session),
  });
  await auth.port.presentAuthorizeUrl({ url: 'https://cursor.com/loginDeepControl?challenge=c' });
  expect(published.at(-1)).toMatchObject({
    status: 'authorize_url',
    url: expect.stringContaining('cursor.com'),
  });
});

test('rejects a non-http authorize URL', async () => {
  const auth = createDashboardAuthorization({
    sessionId: '00000000-0000-4000-8000-000000000000',
    signal: new AbortController().signal,
    publish: () => {},
  });
  await expect(auth.port.presentAuthorizeUrl({ url: 'javascript:alert(1)' })).rejects.toThrow();
});

test('redirects a valid loopback callback to the Dashboard completion page', async () => {
  const published: DashboardOAuthSession[] = [];
  const auth = createDashboardAuthorization({
    sessionId: '00000000-0000-4000-8000-000000000000',
    signal: new AbortController().signal,
    publish: (session) => published.push(session),
    completeUrl: 'http://localhost:3000/dashboard/oauth/complete',
  });
  const loopback = auth.port.loopback({
    state: 'expected-state',
    redirect: { hostname: '127.0.0.1', port: 'dynamic', path: '/oauth-callback' },
    authorizationUrl: ({ redirectUri }) => {
      const url = new URL('https://example.com/authorize');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', 'expected-state');
      return url.href;
    },
    allowManualCallbackUrl: true,
  });
  await Bun.sleep(10);
  const session = published.find((item) => item.status === 'loopback');
  if (session === undefined || session.status !== 'loopback') throw new Error('expected loopback session');
  const redirectUri = new URL(session.authorizationUrl).searchParams.get('redirect_uri');
  if (redirectUri === null) throw new Error('expected redirect_uri');
  const response = await fetch(`${redirectUri}?code=valid-code&state=expected-state`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('http://localhost:3000/dashboard/oauth/complete');
  await expect(loopback).resolves.toEqual({ code: 'valid-code', redirectUri });
  auth.close();
});

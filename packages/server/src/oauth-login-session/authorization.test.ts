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

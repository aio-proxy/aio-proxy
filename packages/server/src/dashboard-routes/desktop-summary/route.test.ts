import { beforeEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readDesktopToken } from '@aio-proxy/core';
import { DesktopSummaryV1Schema } from '@aio-proxy/types';

import { createServer, createServerTestHome } from '#server-test-lifecycle';

import { loopbackServer } from '../../dashboard-auth/test-support';
import type { ServerLog } from '../../server-log';
import { createServer as createUntrackedServer } from '../../server/server';

let dir: string;
beforeEach(() => {
  dir = createServerTestHome();
});

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, host: '127.0.0.1:9317' });
const serve = async (server: Record<string, unknown> = {}, logged?: ServerLog[]) =>
  createServer({
    config: { server: { port: 9_317, ...server }, providers: {} },
    dbHome: dir,
    watchConfig: false,
    ...(logged === undefined ? {} : { logger: (entry: ServerLog) => logged.push(entry) }),
  });

test('the desktop token reads the summary without a dashboard password', async () => {
  const app = await serve();
  const token = readDesktopToken(dir);
  expect(token).toBeDefined();
  const res = await app.request('/dashboard/api/desktop-summary', { headers: bearer(token ?? '') }, loopbackServer);
  expect(res.status).toBe(200);
  expect(DesktopSummaryV1Schema.safeParse(await res.json()).success).toBe(true);
});

test('an unknown range is a 400 and a known one is accepted', async () => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  const get = (query: string) =>
    app.request(`/dashboard/api/desktop-summary${query}`, { headers: bearer(token) }, loopbackServer);
  expect((await get('?range=90d')).status).toBe(400);
  const week = await get('?range=7d');
  expect(week.status).toBe(200);
  expect(DesktopSummaryV1Schema.parse(await week.json()).usage.range).toBe('7d');
});

test('with a dashboard password the token reads the summary but nothing else', async () => {
  const app = await serve({ password: await Bun.password.hash('pw') });
  const token = readDesktopToken(dir) ?? '';
  expect((await app.request('/dashboard/api/desktop-summary', { headers: bearer(token) }, loopbackServer)).status).toBe(
    200,
  );
  expect((await app.request('/dashboard/api/providers', { headers: bearer(token) }, loopbackServer)).status).toBe(401);
});

test('without a password the token grants nothing beyond anonymous loopback access', async () => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  const anonymous = await app.request(
    '/dashboard/api/providers',
    { headers: { host: '127.0.0.1:9317' } },
    loopbackServer,
  );
  const withToken = await app.request('/dashboard/api/providers', { headers: bearer(token) }, loopbackServer);
  expect(withToken.status).toBe(anonymous.status);
});

test('a missing or wrong token is refused', async () => {
  const app = await serve();
  expect(
    (await app.request('/dashboard/api/desktop-summary', { headers: { host: '127.0.0.1:9317' } }, loopbackServer))
      .status,
  ).toBe(401);
  expect(
    (await app.request('/dashboard/api/desktop-summary', { headers: bearer('B'.repeat(43)) }, loopbackServer)).status,
  ).toBe(401);
});

test.each(['192.168.1.20', '2001:db8::1', 'fe80::1', '::ffff:192.168.1.20'])(
  'non-loopback peer %s is refused even when headers claim loopback',
  async (address) => {
    const app = await serve();
    const token = readDesktopToken(dir) ?? '';
    const res = await app.request(
      '/dashboard/api/desktop-summary',
      { headers: { ...bearer(token), origin: 'http://127.0.0.1:9317', 'x-forwarded-for': '127.0.0.1' } },
      peer(address),
    );
    expect(res.status).toBe(401);
  },
);

test.each(['::1', '::ffff:127.0.0.1', '127.0.0.2'])('loopback peer %s is accepted', async (address) => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  expect((await app.request('/dashboard/api/desktop-summary', { headers: bearer(token) }, peer(address))).status).toBe(
    200,
  );
});

test('a real loopback socket reaches the summary with the token', async () => {
  const app = await serve();
  const token = readDesktopToken(dir) ?? '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/dashboard/api/desktop-summary`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  } finally {
    server.stop(true);
  }
});

test('a server with no home still boots and refuses the summary', async () => {
  // Without dbHome/configPath the database falls back to aioHome(); point that at the temp dir so the
  // test never touches the developer's real ~/.aio-proxy. The token home stays undefined regardless.
  // The tracked createServer would inject a dbHome, so this one is built and closed by hand.
  const previous = process.env['AIO_PROXY_HOME'];
  process.env['AIO_PROXY_HOME'] = dir;
  const app = await createUntrackedServer({ config: { server: { port: 9_317 }, providers: {} }, watchConfig: false });
  try {
    const res = await app.request(
      '/dashboard/api/desktop-summary',
      { headers: bearer('A'.repeat(43)) },
      loopbackServer,
    );
    expect(res.status).toBe(401);
    expect(readDesktopToken(dir)).toBeUndefined();
  } finally {
    app.close();
    if (previous === undefined) delete process.env['AIO_PROXY_HOME'];
    else process.env['AIO_PROXY_HOME'] = previous;
  }
});

test('a rejected token file does not stop the server from booting and is logged by reason only', async () => {
  writeFileSync(join(dir, 'desktop-token'), 'A'.repeat(43), { mode: 0o644 });
  const logged: ServerLog[] = [];
  const app = await serve({}, logged);
  const res = await app.request('/dashboard/api/desktop-summary', { headers: bearer('A'.repeat(43)) }, loopbackServer);
  expect(res.status).toBe(401);
  // Exactly this shape reaches the sink: a closed reason, never the path or an errno message.
  expect(logged.filter((entry) => entry.event === 'desktop_token.unavailable')).toEqual([
    { event: 'desktop_token.unavailable', reason: 'insecure_mode' },
  ]);
});

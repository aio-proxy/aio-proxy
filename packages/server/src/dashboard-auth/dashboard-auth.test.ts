import { describe, expect, test } from 'bun:test';

import { createServer as createBaseServer } from '../server';
import { loopbackServer } from './test-support';

const origin = 'http://127.0.0.1:22078';
const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
  createBaseServer({ ...options, port: 22_078 });

async function login(
  app: Awaited<ReturnType<typeof createServer>>,
  password: string,
  requestOrigin = origin,
  requestServer = loopbackServer,
): Promise<Response> {
  return app.request(
    '/dashboard/api/auth/login',
    {
      body: JSON.stringify({ password }),
      headers: { 'content-type': 'application/json', host: new URL(requestOrigin).host, origin: requestOrigin },
      method: 'POST',
    },
    requestServer,
  );
}

async function tokenFrom(response: Response): Promise<string> {
  const token = ((await response.clone().json()) as { readonly token?: unknown }).token;
  if (typeof token !== 'string') throw new Error('missing session token');
  return token;
}

describe('dashboard authentication', () => {
  test('protects Dashboard APIs and accepts a Bearer password session', async () => {
    const hash = await Bun.password.hash('correct horse');
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });

    const sessionBefore = await app.request('/dashboard/api/auth/session', undefined, loopbackServer);
    const protectedBefore = await app.request('/dashboard/api/config', undefined, loopbackServer);
    const wrong = await login(app, 'wrong');
    const correct = await login(app, 'correct horse');
    const token = await tokenFrom(correct);
    const protectedWithCookie = await app.request(
      '/dashboard/api/config',
      { headers: { cookie: `aio_proxy_dashboard_session=${token}` } },
      loopbackServer,
    );
    const protectedAfter = await app.request(
      '/dashboard/api/config',
      { headers: { authorization: `Bearer ${token}` } },
      loopbackServer,
    );

    expect(sessionBefore.status).toBe(200);
    expect(await sessionBefore.json()).toEqual({ status: 'unauthenticated' });
    expect(protectedBefore.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(correct.status).toBe(200);
    expect(token).toBeString();
    expect(correct.headers.get('set-cookie')).toBeNull();
    expect(protectedWithCookie.status).toBe(401);
    expect(protectedAfter.status).toBe(200);
    expect(await protectedAfter.json()).toMatchObject({ server: { password: '****' } });
  });

  test('accepts a session after recreating the server with the same hash', async () => {
    const hash = await Bun.password.hash('restart-safe');
    const first = await createServer({ config: { server: { password: hash }, providers: {} } });
    const token = await tokenFrom(await login(first, 'restart-safe'));
    const second = await createServer({ config: { server: { password: hash }, providers: {} } });

    expect(
      (await second.request('/dashboard/api/config', { headers: { authorization: `Bearer ${token}` } }, loopbackServer))
        .status,
    ).toBe(200);
  });

  test('logout does not create a Cookie', async () => {
    const hash = await Bun.password.hash('logout');
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });
    const token = await tokenFrom(await login(app, 'logout'));

    const response = await app.request(
      '/dashboard/api/auth/logout',
      {
        headers: { authorization: `Bearer ${token}`, host: '127.0.0.1:22078', origin },
        method: 'POST',
      },
      loopbackServer,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('accepts login from the IPv6 loopback Dashboard origin', async () => {
    const hash = await Bun.password.hash('ipv6-loopback');
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });

    expect((await login(app, 'ipv6-loopback', 'http://[::1]:22078')).status).toBe(200);
  });

  test('rejects remote Dashboard clients without a password without blocking model APIs', async () => {
    const app = await createServer({
      config: { providers: {} },
      dashboardAssets: async (path) => (path === 'index.html' ? new Response('Dashboard') : undefined),
    });
    const remote = { requestIP: () => ({ address: '192.168.1.20' }) };

    expect((await app.request('/dashboard/api/auth/session', undefined, remote)).status).toBe(404);
    expect((await app.request('/dashboard', undefined, remote)).status).toBe(404);
    expect((await app.request('/dashboard/api/auth/session')).status).toBe(404);
    expect((await app.request('/dashboard')).status).toBe(404);
    expect((await app.request('/dashboard', undefined, loopbackServer)).status).toBe(200);
    expect((await app.request('/v1/models', undefined, remote)).status).toBe(200);
  });

  test('permits remote Dashboard Bearer access while Admin remains loopback-only', async () => {
    const remote = { requestIP: () => ({ address: '192.168.1.20' }) };
    const remoteOrigin = 'http://proxy.example:22078';
    const hash = await Bun.password.hash('remote-password');
    const app = await createServer({
      config: { server: { password: hash }, providers: {} },
      dashboardAssets: async (path) => (path === 'index.html' ? new Response('Dashboard') : undefined),
    });
    const loginResponse = await login(app, 'remote-password', remoteOrigin, remote);
    const token = await tokenFrom(loginResponse);
    const headers = { authorization: `Bearer ${token}`, host: 'proxy.example:22078', origin: remoteOrigin };

    expect(loginResponse.status).toBe(200);
    expect((await app.request('/dashboard', { headers: { host: 'proxy.example:22078' } }, remote)).status).toBe(200);
    expect((await app.request('/dashboard/api/config', { headers }, remote)).status).toBe(200);
    expect((await app.request('/admin/reload', { headers, method: 'POST' }, remote)).status).toBe(403);
  });

  test('rate limits all attempts after five failures', async () => {
    const hash = await Bun.password.hash('eventually-correct');
    const app = await createServer({ config: { server: { password: hash }, providers: {} } });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(app, 'wrong')).status).toBe(401);
    }
    const blocked = await login(app, 'eventually-correct');

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
  });
});

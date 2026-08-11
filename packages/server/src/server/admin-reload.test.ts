import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createBaseServer } from '@aio-proxy/server';

import { loopbackServer } from '../dashboard-auth/test-support';

describe('admin control plane', () => {
  let dir: string;
  // Empty providers config guarantees a clean reload snapshot (ok:true), independent
  // of the shared secret-laden fixture used by server-config.test.ts.
  const emptyConfig = { server: { port: 9_317 }, providers: {} };
  const createServer = (version?: string, config = emptyConfig) =>
    createBaseServer({ config, dbHome: dir, watchConfig: false, ...(version ? { version } : {}) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aio-proxy-admin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('POST /admin/reload is reachable on loopback without CSRF or auth', async () => {
    const app = await createServer();
    // No Origin header, no auth cookie — the dashboard routes would 403/401 here.
    const res = await app.request('/admin/reload', { method: 'POST' }, loopbackServer);
    expect([200, 409]).toContain(res.status);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('ok');
  });

  test('POST /admin/reload rejects a cross-origin browser request', async () => {
    const app = await createServer();
    // A drive-by page on another origin submits a cross-origin POST; even though
    // the browser connects from loopback, the foreign Origin must be refused.
    const res = await app.request(
      '/admin/reload',
      { method: 'POST', headers: { origin: 'https://evil.example' } },
      loopbackServer,
    );
    expect(res.status).toBe(403);
  });

  test('POST /admin/reload rejects an attacker Origin even when Host matches', async () => {
    const app = await createServer();
    const res = await app.request(
      '/admin/reload',
      { method: 'POST', headers: { host: 'attacker.example', origin: 'http://attacker.example' } },
      loopbackServer,
    );
    expect(res.status).toBe(403);
  });

  test('POST /admin/reload rejects a cross-site fetch-metadata request', async () => {
    const app = await createServer();
    const res = await app.request(
      '/admin/reload',
      { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } },
      loopbackServer,
    );
    expect(res.status).toBe(403);
  });

  test('POST /admin/reload allows a same-origin browser request', async () => {
    const app = await createServer();
    // The bundled dashboard (same origin) legitimately reloads; it must pass.
    const res = await app.request(
      '/admin/reload',
      {
        method: 'POST',
        headers: { host: '127.0.0.1:9317', origin: 'http://127.0.0.1:9317', 'sec-fetch-site': 'same-origin' },
      },
      loopbackServer,
    );
    expect([200, 409]).toContain(res.status);
  });

  test('POST /admin/reload allows an IPv6 loopback same-origin browser request', async () => {
    const app = await createServer();

    const res = await app.request(
      '/admin/reload',
      {
        method: 'POST',
        headers: { host: '[::1]:9317', origin: 'http://[::1]:9317', 'sec-fetch-site': 'same-origin' },
      },
      loopbackServer,
    );

    expect([200, 409]).toContain(res.status);
  });

  test('POST /admin/reload rejects a loopback origin on another port', async () => {
    const app = await createServer();

    const res = await app.request(
      '/admin/reload',
      { method: 'POST', headers: { origin: 'http://127.0.0.1:22078' } },
      loopbackServer,
    );

    expect(res.status).toBe(403);
  });

  test('POST /admin/reload rejects a different loopback host on the proxy port', async () => {
    const app = await createServer();

    const res = await app.request(
      '/admin/reload',
      { method: 'POST', headers: { origin: 'http://127.0.0.2:9317' } },
      loopbackServer,
    );

    expect(res.status).toBe(403);
  });

  test('POST /admin/reload remains unavailable to remote clients with a Dashboard session', async () => {
    const hash = await Bun.password.hash('remote-admin');
    const app = await createServer(undefined, { server: { password: hash }, providers: {} });
    const remote = { requestIP: () => ({ address: '192.168.1.20' }) };
    const origin = 'http://proxy.example:9317';
    const login = await app.request(
      '/dashboard/api/auth/login',
      {
        body: JSON.stringify({ password: 'remote-admin' }),
        headers: { 'content-type': 'application/json', host: 'proxy.example:9317', origin },
        method: 'POST',
      },
      remote,
    );
    const token = ((await login.clone().json()) as { readonly token?: string }).token;

    expect(login.status).toBe(200);
    expect(
      (await app.request('/admin/reload', { headers: { host: 'proxy.example:9317', origin }, method: 'POST' }, remote))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/admin/reload',
          { headers: { authorization: `Bearer ${token ?? ''}`, host: 'proxy.example:9317', origin }, method: 'POST' },
          remote,
        )
      ).status,
    ).toBe(403);
  });

  test('GET /health reports the injected version', async () => {
    const app = await createServer('9.9.9-test');
    const res = await app.request('/health', undefined, loopbackServer);
    const body = await res.json();
    expect(body.version).toBe('9.9.9-test');
  });
});

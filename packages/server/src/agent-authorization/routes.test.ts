import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentIdentityService } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import { createServer } from '#server-test-lifecycle';

import { loopbackServer } from '../dashboard-auth/test-support';

const DEVICE_REQUEST = {
  client_id: 'aio-proxy-opencode',
  agent: 'opencode',
  installation_id: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapter_version: '1.2.3',
} as const;

const routeHomes: string[] = [];
const routeCloses: Array<() => void> = [];

afterEach(() => {
  for (const close of routeCloses.splice(0)) close();
  for (const home of routeHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const LOCAL_ORIGIN = 'http://127.0.0.1:9317';
const localUrl = (path: string): string => `${LOCAL_ORIGIN}${path}`;
const form = (value: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(value),
});
const json = (value: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
});

async function routeFixture(server: { apiKeys?: Array<{ key: string }>; password?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-routes-'));
  routeHomes.push(home);
  const identityDb = openDb({ home: join(home, 'identity') });
  routeCloses.push(identityDb.close);
  const agentIdentity = createAgentIdentityService(identityDb.sqlite);
  const logs: unknown[] = [];
  const app = await createServer({
    config: { server: { host: '127.0.0.1', port: 9_317, ...server }, providers: {} },
    dbHome: join(home, 'server'),
    host: '127.0.0.1',
    port: 9_317,
    logger: (entry) => logs.push(entry),
    __test: { agentIdentity },
  });
  routeCloses.push(() => app.close());
  return {
    app,
    agentIdentity,
    logs,
    login: async (password: string): Promise<string> => {
      const response = await app.request(
        '/dashboard/api/auth/login',
        json(
          { password },
          {
            origin: LOCAL_ORIGIN,
            'sec-fetch-site': 'same-origin',
          },
        ),
        loopbackServer,
      );
      const body = await response.json();
      if (!response.ok || typeof body.token !== 'string') throw new Error('Dashboard login failed in fixture');
      return body.token;
    },
  };
}

test('device endpoint is form-only, loopback-only, and binds the fixed client tuple', async () => {
  const f = await routeFixture();
  const valid = await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer);
  expect(valid.status).toBe(200);
  expect(valid.headers.get('cache-control')).toBe('no-store');
  const created = await valid.json();
  const deviceCode = created.device_code;
  const userCode = created.user_code;
  expect(created).toMatchObject({
    user_code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u),
    verification_uri_complete: expect.stringContaining('/dashboard/agents/authorize#code='),
  });
  expect(JSON.stringify(f.logs)).not.toContain(deviceCode);
  expect(JSON.stringify(f.logs)).not.toContain(userCode);
  expect(
    (
      await f.app.request(
        '/oauth/device/code',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(DEVICE_REQUEST),
        },
        loopbackServer,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), {
        requestIP: () => ({ address: '203.0.113.10' }),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.app.request(
        '/oauth/device/code',
        {
          ...form(DEVICE_REQUEST),
          headers: {
            ...form(DEVICE_REQUEST).headers,
            forwarded: 'for=127.0.0.1',
            'x-forwarded-for': '127.0.0.1',
          },
        },
        { requestIP: () => ({ address: '203.0.113.10' }) },
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.app.request('/oauth/device/code', form({ ...DEVICE_REQUEST, client_id: 'aio-proxy-pi' }), loopbackServer))
      .status,
  ).toBe(400);
});

test('static API keys without a Dashboard password disable challenge creation', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }] });
  const response = await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'authorization_unavailable' });
});

test.each(['resolve', 'approve', 'deny'] as const)(
  'Dashboard %s maps DeviceChallengeError rate limits to stable 429 JSON',
  async (operation) => {
    const f = await routeFixture();
    const path =
      operation === 'resolve'
        ? localUrl('/dashboard/api/agent-authorizations/resolve')
        : localUrl(`/dashboard/api/agent-authorizations/${crypto.randomUUID()}/${operation}`);
    const init =
      operation === 'resolve'
        ? json(
            { userCode: 'ZZZZ-ZZZZ' },
            {
              origin: LOCAL_ORIGIN,
              'sec-fetch-site': 'same-origin',
            },
          )
        : json({}, { origin: LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin' });
    for (let index = 0; index < 10; index += 1) {
      expect((await f.app.request(path, init, loopbackServer)).status).toBe(200);
    }
    const limited = await f.app.request(path, init, loopbackServer);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
  },
);

test('approval requires both Dashboard session and same origin when locked', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }], password: 'dashboard-password' });
  const created = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const resolveBody = { userCode: created.user_code };
  const originOnly = await f.app.request(
    localUrl('/dashboard/api/agent-authorizations/resolve'),
    json(resolveBody, {
      origin: LOCAL_ORIGIN,
    }),
    loopbackServer,
  );
  expect(originOnly.status).toBe(401);

  const token = await f.login('dashboard-password');
  const crossOrigin = await f.app.request(
    localUrl('/dashboard/api/agent-authorizations/resolve'),
    json(resolveBody, {
      authorization: `Bearer ${token}`,
      origin: 'https://evil.example',
    }),
    loopbackServer,
  );
  expect(crossOrigin.status).toBe(403);
  const resolved = await f.app.request(
    localUrl('/dashboard/api/agent-authorizations/resolve'),
    json(resolveBody, {
      authorization: `Bearer ${token}`,
      origin: LOCAL_ORIGIN,
      'sec-fetch-site': 'same-origin',
    }),
    loopbackServer,
  );
  expect(resolved.status).toBe(200);
  const details = await resolved.json();
  expect(details).not.toHaveProperty('device_code');
  const approved = await f.app.request(
    localUrl(`/dashboard/api/agent-authorizations/${details.deviceId}/approve`),
    json(
      {},
      {
        authorization: `Bearer ${token}`,
        origin: LOCAL_ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
    ),
    loopbackServer,
  );
  expect(await approved.json()).toEqual({ status: 'approved' });

  const deniedChallenge = await (
    await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)
  ).json();
  const deniedDetails = await (
    await f.app.request(
      localUrl('/dashboard/api/agent-authorizations/resolve'),
      json(
        { userCode: deniedChallenge.user_code },
        {
          authorization: `Bearer ${token}`,
          origin: LOCAL_ORIGIN,
          'sec-fetch-site': 'same-origin',
        },
      ),
      loopbackServer,
    )
  ).json();
  const denied = await f.app.request(
    localUrl(`/dashboard/api/agent-authorizations/${deniedDetails.deviceId}/deny`),
    json(
      {},
      {
        authorization: `Bearer ${token}`,
        origin: LOCAL_ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
    ),
    loopbackServer,
  );
  expect(await denied.json()).toEqual({ status: 'denied' });
});

test('an authenticated remote Dashboard may approve a challenge created by a local plugin', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }], password: 'dashboard-password' });
  const created = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const token = await f.login('dashboard-password');
  const remoteServer = { requestIP: () => ({ address: '203.0.113.10' }) };
  const resolved = await f.app.request(
    'https://proxy.example/dashboard/api/agent-authorizations/resolve',
    json(
      { userCode: created.user_code },
      {
        authorization: `Bearer ${token}`,
        origin: 'https://proxy.example',
        'sec-fetch-site': 'same-origin',
      },
    ),
    remoteServer,
  );
  expect(resolved.status).toBe(200);
  const details = await resolved.json();
  const approved = await f.app.request(
    `https://proxy.example/dashboard/api/agent-authorizations/${details.deviceId}/approve`,
    json(
      {},
      {
        authorization: `Bearer ${token}`,
        origin: 'https://proxy.example',
        'sec-fetch-site': 'same-origin',
      },
    ),
    remoteServer,
  );
  expect(await approved.json()).toEqual({ status: 'approved' });
});

test('a remote request with the configured local Origin is forbidden even with a Dashboard session', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }], password: 'dashboard-password' });
  const created = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const token = await f.login('dashboard-password');
  const remote = await f.app.request(
    'https://proxy.example/dashboard/api/agent-authorizations/resolve',
    json(
      { userCode: created.user_code },
      {
        authorization: `Bearer ${token}`,
        origin: LOCAL_ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
    ),
    { requestIP: () => ({ address: '203.0.113.10' }) },
  );
  expect(remote.status).toBe(403);
});

test('token endpoint consumes once, replays the same result, rotates, and never logs credentials', async () => {
  const f = await routeFixture();
  const created = await (await f.app.request('/oauth/device/code', form(DEVICE_REQUEST), loopbackServer)).json();
  const details = await (
    await f.app.request(
      localUrl('/dashboard/api/agent-authorizations/resolve'),
      json(
        { userCode: created.user_code },
        {
          origin: LOCAL_ORIGIN,
          'sec-fetch-site': 'same-origin',
        },
      ),
      loopbackServer,
    )
  ).json();
  await f.app.request(
    localUrl(`/dashboard/api/agent-authorizations/${details.deviceId}/approve`),
    json({}, { origin: LOCAL_ORIGIN, 'sec-fetch-site': 'same-origin' }),
    loopbackServer,
  );
  const deviceGrant = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: DEVICE_REQUEST.client_id,
    device_code: created.device_code,
  };
  const first = await f.app.request('/oauth/token', form(deviceGrant), loopbackServer);
  const firstBody = await first.clone().json();
  const duplicateBody = await (await f.app.request('/oauth/token', form(deviceGrant), loopbackServer)).json();
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('no-store');
  expect(duplicateBody).toEqual(firstBody);

  const refreshBody = await (
    await f.app.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        client_id: DEVICE_REQUEST.client_id,
        refresh_token: firstBody.refresh_token,
      }),
      loopbackServer,
    )
  ).json();
  expect(refreshBody.access_token).not.toBe(firstBody.access_token);
  expect(refreshBody.refresh_token).not.toBe(firstBody.refresh_token);
  const serializedLogs = JSON.stringify(f.logs);
  for (const secret of [
    created.device_code,
    created.user_code,
    firstBody.access_token,
    firstBody.refresh_token,
    refreshBody.access_token,
    refreshBody.refresh_token,
  ]) {
    expect(serializedLogs).not.toContain(secret);
  }
});

test('refresh validates client binding before any replay result can be returned', async () => {
  const f = await routeFixture();
  const token = f.agentIdentity.issueCredential({
    installationId: DEVICE_REQUEST.installation_id,
    target: 'opencode',
    adapterVersion: '1.2.3',
  });
  const wrongClient = await f.app.request(
    '/oauth/token',
    form({
      grant_type: 'refresh_token',
      client_id: 'aio-proxy-pi',
      refresh_token: token.refreshToken,
    }),
    loopbackServer,
  );
  expect(wrongClient.status).toBe(400);
  expect(await wrongClient.json()).toMatchObject({ error: 'invalid_grant' });
  const correct = await f.app.request(
    '/oauth/token',
    form({
      grant_type: 'refresh_token',
      client_id: DEVICE_REQUEST.client_id,
      refresh_token: token.refreshToken,
    }),
    loopbackServer,
  );
  expect(correct.status).toBe(200);
});

test('admin snapshot and revoke are loopback-only, idempotent, and secret-free', async () => {
  const f = await routeFixture({ apiKeys: [{ key: 'static' }] });
  const response = await f.app.request('/admin/agent-installations', undefined, loopbackServer);
  const body = await response.json();
  expect(body).toEqual({
    installations: [],
    deviceAuthorization: 'password_required',
    catalogSchemaVersions: [1],
  });
  expect(JSON.stringify(body).toLowerCase()).not.toContain('hash');
  const id = DEVICE_REQUEST.installation_id;
  const first = await f.app.request(`/admin/agent-installations/${id}/revoke`, { method: 'POST' }, loopbackServer);
  const second = await f.app.request(`/admin/agent-installations/${id}/revoke`, { method: 'POST' }, loopbackServer);
  expect(await first.json()).toEqual({ installationId: id, status: 'missing' });
  expect(await second.json()).toEqual({ installationId: id, status: 'missing' });

  const remoteFixture = await routeFixture({ password: 'dashboard-password' });
  const dashboardToken = await remoteFixture.login('dashboard-password');
  const remote = await remoteFixture.app.request(
    '/admin/agent-installations',
    {
      headers: { authorization: `Bearer ${dashboardToken}` },
    },
    { requestIP: () => ({ address: '203.0.113.10' }) },
  );
  expect(remote.status).toBe(404);
});

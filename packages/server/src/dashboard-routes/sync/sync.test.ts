import { expect, test } from 'bun:test';

import type {
  DashboardEvent,
  SyncBackendView,
  SyncControlPlane,
  SyncHistoryItem,
  SyncPreview,
  SyncStatus,
} from '@aio-proxy/types';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import { loopbackServer } from '../../dashboard-auth/test-support';
import { SyncOperationError, SyncPreviewError } from '../../sync-control-plane';
import { createSyncRoutes } from './sync';

const origin = 'http://127.0.0.1:22078';

const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
  createBaseServer({ ...options, port: 22_078 });

const status: SyncStatus = {
  state: 'idle',
  backend: { plugin: 'sync-plugin', capability: 'sync', spaceId: 'space' },
  providers: [],
  pendingOperations: 0,
  lastSuccessAt: null,
};

const preview: SyncPreview = {
  previewId: 'preview-1',
  kind: 'join',
  rows: [],
  retainedSharedPlugins: [],
  expiresAt: 1,
};

function control(overrides: Partial<SyncControlPlane> = {}): SyncControlPlane {
  return {
    status: () => status,
    backends: () => [] as SyncBackendView[],
    preview: async () => preview,
    apply: async () => status,
    setRange: async () => status,
    detach: async () => status,
    cancelDetach: async () => status,
    history: async () => [] as SyncHistoryItem[],
    retry: async () => status,
    disconnect: async () => status,
    ...overrides,
  };
}

function eventHub(received: DashboardEvent[]): { publish: (event: DashboardEvent) => void } {
  return { publish: (event) => received.push(event) };
}

test('sync API requires existing dashboard authentication', async () => {
  const hash = await Bun.password.hash('sync-password');
  const app = await createServer({ config: { server: { password: hash }, providers: {} } });

  const response = await app.request(
    '/dashboard/api/sync',
    { headers: { host: new URL(origin).host, origin } },
    loopbackServer,
  );

  expect(response.status).toBe(401);

  const login = await app.request(
    '/dashboard/api/auth/login',
    {
      body: JSON.stringify({ password: 'sync-password' }),
      headers: { 'content-type': 'application/json', host: new URL(origin).host, origin },
      method: 'POST',
    },
    loopbackServer,
  );
  const token = ((await login.json()) as { readonly token: string }).token;
  const allowed = await app.request(
    '/dashboard/api/sync',
    { headers: { authorization: `Bearer ${token}` } },
    loopbackServer,
  );

  expect(allowed.status).toBe(200);
  const body = await allowed.text();
  expect(body).not.toContain('backend-secret');
  expect(body).not.toContain('work-refresh-secret');
});

test('password-disabled sync API keeps loopback and Origin protections', async () => {
  const app = await createServer({ config: { providers: {} } });

  const allowed = await app.request(
    '/dashboard/api/sync',
    { headers: { host: new URL(origin).host, origin } },
    loopbackServer,
  );
  expect(allowed.status).toBe(200);

  const wrongHost = await app.request(
    '/dashboard/api/sync',
    { headers: { host: 'attacker.example:22078', origin: 'http://attacker.example:22078' } },
    loopbackServer,
  );
  expect(wrongHost.status).toBe(403);

  const wrongOrigin = await app.request(
    '/dashboard/api/sync/retry',
    { method: 'POST', headers: { host: new URL(origin).host, origin: 'https://evil.example' } },
    loopbackServer,
  );
  expect(wrongOrigin.status).toBe(403);

  const remote = await app.request('/dashboard/api/sync', undefined, { requestIP: () => ({ address: '192.0.2.10' }) });
  expect(remote.status).toBe(404);
});

test('sync routes validate inputs and map control-plane failures without native details', async () => {
  const routes = createSyncRoutes(
    control({
      preview: async () => {
        throw new SyncPreviewError('preview-stale');
      },
      apply: async () => {
        throw new Error('work-refresh-secret');
      },
    }),
  );

  const invalid = await routes.request('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'join' }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ ok: false, error: { code: 'invalid-request' } });

  const malformed = await routes.request('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ ok: false, error: { code: 'invalid-request' } });

  const stale = await routes.request('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'join', providerId: 'provider-1' }),
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ ok: false, error: { code: 'preview-stale' } });

  const native = await routes.request('/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: 'preview-1', decisions: [] }),
  });
  expect(native.status).toBe(503);
  const nativeBody = await native.text();
  expect(JSON.parse(nativeBody)).toEqual({ ok: false, error: { code: 'backend-unavailable' } });
  expect(nativeBody).not.toContain('work-refresh-secret');
});

test('sync routes delegate every operation and publish status-only change events', async () => {
  const calls: string[] = [];
  const received: DashboardEvent[] = [];
  const routes = createSyncRoutes(
    control({
      preview: async (input) => {
        calls.push(`preview:${input.kind}`);
        return preview;
      },
      apply: async (input) => {
        calls.push(`apply:${input.previewId}`);
        return status;
      },
      setRange: async (providerId, included) => {
        calls.push(`range:${providerId}:${included}`);
        return status;
      },
      detach: async (providerId, loginSessionId) => {
        calls.push(`detach:${providerId}:${loginSessionId}`);
        return status;
      },
      cancelDetach: async (providerId) => {
        calls.push(`cancel:${providerId}`);
        return status;
      },
      history: async (objectId) => {
        calls.push(`history:${objectId}`);
        return [{ operationId: 'operation-1', objectId, writtenAt: 1, current: true }];
      },
      retry: async () => {
        calls.push('retry');
        return status;
      },
      disconnect: async () => {
        calls.push('disconnect');
        return status;
      },
    }),
    eventHub(received),
  );

  expect((await routes.request('/')).status).toBe(200);
  expect((await routes.request('/backends')).status).toBe(200);
  expect(
    (
      await routes.request('/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'join', providerId: 'provider-1' }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await routes.request('/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: 'preview-1', decisions: [] }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await routes.request('/range', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-1', included: false }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await routes.request('/detach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-1', loginSessionId: 'login-1' }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await routes.request('/detach/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-1' }),
      })
    ).status,
  ).toBe(200);
  expect((await routes.request('/history/object-1')).status).toBe(200);
  expect((await routes.request('/retry', { method: 'POST' })).status).toBe(200);
  expect((await routes.request('/disconnect', { method: 'POST' })).status).toBe(200);

  expect(calls).toEqual([
    'preview:join',
    'apply:preview-1',
    'range:provider-1:false',
    'detach:provider-1:login-1',
    'cancel:provider-1',
    'history:object-1',
    'retry',
    'disconnect',
  ]);
  expect(received).toEqual([
    { event: 'sync.changed', data: { state: 'idle' } },
    { event: 'sync.changed', data: { state: 'idle' } },
    { event: 'sync.changed', data: { state: 'idle' } },
    { event: 'sync.changed', data: { state: 'idle' } },
    { event: 'sync.changed', data: { state: 'idle' } },
    { event: 'sync.changed', data: { state: 'idle' } },
    { event: 'sync.changed', data: { state: 'idle' } },
  ]);
});

test('sync routes preserve the documented offline and state-conflict codes', async () => {
  const routes = createSyncRoutes(
    control({
      setRange: async () => {
        throw new SyncOperationError('upgrade-required');
      },
      disconnect: async () => {
        throw new SyncOperationError('not-connected');
      },
    }),
  );

  const range = await routes.request('/range', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'provider-1', included: false }),
  });
  expect(range.status).toBe(409);
  expect(await range.json()).toEqual({ ok: false, error: { code: 'upgrade-required' } });

  const disconnect = await routes.request('/disconnect', { method: 'POST' });
  expect(disconnect.status).toBe(503);
  expect(await disconnect.json()).toEqual({ ok: false, error: { code: 'not-connected' } });
});

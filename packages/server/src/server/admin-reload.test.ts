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
  const createServer = (version?: string) =>
    createBaseServer({ config: emptyConfig, dbHome: dir, watchConfig: false, ...(version ? { version } : {}) });

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

  test('GET /health reports the injected version', async () => {
    const app = await createServer('9.9.9-test');
    const res = await app.request('/health', undefined, loopbackServer);
    const body = await res.json();
    expect(body.version).toBe('9.9.9-test');
  });
});

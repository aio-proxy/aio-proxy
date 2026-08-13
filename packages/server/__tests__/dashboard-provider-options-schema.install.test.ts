import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createBaseServer } from '@aio-proxy/server';

import { loopbackServer } from '../src/dashboard-auth/test-support';

const installRequest = (body: Record<string, unknown>) => ({
  body: JSON.stringify(body),
  headers: {
    'content-type': 'application/json',
    Host: '127.0.0.1:22078',
    Origin: 'http://127.0.0.1:22078',
  },
  method: 'POST',
});

describe('dashboard provider package metadata', () => {
  let home: string;
  let previousHome: string | undefined;
  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: home, port: 22_078 });

  beforeEach(() => {
    previousHome = process.env.AIO_PROXY_HOME;
    home = mkdtempSync(join(tmpdir(), 'aio-proxy-provider-schema-'));
    process.env.AIO_PROXY_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.AIO_PROXY_HOME;
    } else {
      process.env.AIO_PROXY_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test('trusted packages may install without confirmation', async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      '/dashboard/api/providers/install',
      installRequest({ npm: '@ai-sdk/aio-proxy-missing-provider', registry: 'http://127.0.0.1:9' }),
      loopbackServer,
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('Runtime install failed');
  });

  test('trusted packages may install with explicit false confirmation', async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      '/dashboard/api/providers/install',
      installRequest({
        npm: '@ai-sdk/aio-proxy-missing-provider',
        confirmed: false,
        registry: 'http://127.0.0.1:9',
      }),
      loopbackServer,
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('Runtime install failed');
  });

  test('untrusted packages require explicit confirmation', async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      '/dashboard/api/providers/install',
      installRequest({ npm: 'aio-proxy-missing-provider' }),
      loopbackServer,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'confirmation_required',
      error: 'provider install requires confirmation',
    });
  });

  test('untrusted packages reject explicit false confirmation', async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request(
      '/dashboard/api/providers/install',
      installRequest({ npm: 'aio-proxy-missing-provider', confirmed: false }),
      loopbackServer,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'confirmation_required',
      error: 'provider install requires confirmation',
    });
  });
});

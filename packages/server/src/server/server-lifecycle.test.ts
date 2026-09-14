import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loopbackServer } from '../dashboard-auth/test-support';
import { createServer } from './server';

const originalHome = process.env.AIO_PROXY_HOME;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = originalHome;
});

const isolateHome = (prefix: string) => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  process.env.AIO_PROXY_HOME = home;
  return home;
};

test('createServer exposes idempotent close and route-assembly failure closes state', async () => {
  const home = isolateHome('aio-proxy-app-close-');
  const first = await createServer({
    config: { providers: {} },
    dbHome: home,
    autoUpdate: {
      isManagedService: () => false,
      applyUpdate: async () => 'unchanged',
      fetchLatest: async () => '0.0.0',
    },
  });
  first.close();
  first.close();
  // `closeAsync` after a synchronous close must delegate rather than latch: it awaits the drain
  // `close()` left running instead of resolving straight away, and must not tear down twice.
  await first.closeAsync();
  const second = await createServer({
    config: { providers: {} },
    dbHome: home,
    autoUpdate: {
      isManagedService: () => false,
      applyUpdate: async () => 'unchanged',
      fetchLatest: async () => '0.0.0',
    },
  });
  second.close();

  await expect(
    createServer({
      config: { providers: {} },
      dbHome: home,
      autoUpdate: {
        isManagedService: () => false,
        applyUpdate: async () => 'unchanged',
        fetchLatest: async () => '0.0.0',
      },
      __test: {
        createRoutes: () => {
          throw new Error('injected route assembly failure');
        },
      },
    }),
  ).rejects.toThrow('injected route assembly failure');
  const afterFailure = await createServer({
    config: { providers: {} },
    dbHome: home,
    autoUpdate: {
      isManagedService: () => false,
      applyUpdate: async () => 'unchanged',
      fetchLatest: async () => '0.0.0',
    },
  });
  afterFailure.close();
});

test('createServer never applies an update on start', async () => {
  const home = isolateHome('aio-proxy-auto-update-unmanaged-');
  const applyUpdate = mock(async () => 'installed' as const);
  const app = await createServer({
    config: { providers: {} },
    dbHome: home,
    version: '1.0.0',
    autoUpdate: {
      isManagedService: () => true,
      applyUpdate,
      fetchLatest: async () => '2.0.0',
    },
  });
  await Promise.resolve();
  expect(applyUpdate).not.toHaveBeenCalled();
  app.close();
});

test('createServer reports managedService from the injected auto-update hooks', async () => {
  const home = isolateHome('aio-proxy-auto-update-managed-view-');
  const app = await createServer({
    config: { providers: {} },
    dbHome: home,
    version: '1.0.0',
    autoUpdate: {
      isManagedService: () => true,
      applyUpdate: async () => 'unchanged',
      fetchLatest: () => new Promise(() => {}),
    },
  });
  const response = await app.request('/dashboard/api/release', undefined, loopbackServer);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    current: '1.0.0',
    outdated: false,
    managedService: true,
    update: { status: 'idle' },
  });
  app.close();
});

test('configured keys the operator switched off stop rejecting callers and warn on a public bind', async () => {
  const home = isolateHome('aio-proxy-require-api-key-off-');
  const logs: { readonly event: string }[] = [];
  const app = await createServer({
    config: {
      server: { host: '0.0.0.0', apiKeys: [{ key: 'static' }], requireApiKey: false },
      providers: {},
    },
    dbHome: home,
    host: '0.0.0.0',
    logger: (entry) => logs.push(entry as { readonly event: string }),
  });

  // A wrong credential is not "wrong" against a policy that enforces nothing: with keys still
  // authored the caller must be admitted, or turning enforcement off would achieve nothing.
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'x-api-key': 'static' }]) {
    expect((await app.request('/v1/models', { headers })).status).toBe(200);
  }
  // Reachable from the network with nothing checked: advisory only, since the operator may be
  // behind their own gateway, but it must not be silent.
  expect(logs.filter((entry) => entry.event === 'server.api_key_enforcement_disabled')).toEqual([
    { event: 'server.api_key_enforcement_disabled', host: '0.0.0.0' },
  ]);
  app.close();
});

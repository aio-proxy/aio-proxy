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

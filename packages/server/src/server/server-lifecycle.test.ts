import { expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loopbackServer } from '../dashboard-auth/test-support';
import { createServer } from './server';

test('createServer exposes idempotent close and route-assembly failure closes state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-app-close-'));
  const first = await createServer({ config: { providers: {} }, dbHome: home });
  first.close();
  first.close();
  const second = await createServer({ config: { providers: {} }, dbHome: home });
  second.close();

  await expect(
    createServer({
      config: { providers: {} },
      dbHome: home,
      __test: {
        createRoutes: () => {
          throw new Error('injected route assembly failure');
        },
      },
    }),
  ).rejects.toThrow('injected route assembly failure');
  const afterFailure = await createServer({ config: { providers: {} }, dbHome: home });
  afterFailure.close();
});

test('createServer never applies an update on start', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-auto-update-unmanaged-'));
  const applyUpdate = mock(async () => 'installed' as const);
  const app = await createServer({
    config: { providers: {} },
    dbHome: home,
    version: '1.0.0',
    autoUpdate: { isManagedService: () => true, applyUpdate },
  });
  await Promise.resolve();
  expect(applyUpdate).not.toHaveBeenCalled();
  app.close();
});

test('createServer reports managedService from the injected auto-update hooks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-auto-update-managed-view-'));
  const app = await createServer({
    config: { providers: {} },
    dbHome: home,
    version: '1.0.0',
    autoUpdate: {
      isManagedService: () => true,
      applyUpdate: async () => 'unchanged',
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

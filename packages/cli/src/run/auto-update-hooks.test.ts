import { expect, mock, test } from 'bun:test';

import { createCliAutoUpdateHooks, isManagedAutoUpdateProcess, migratePreMarkerManagedUnit } from './auto-update-hooks';

test('isManagedAutoUpdateProcess accepts the marker and pre-marker manager env', () => {
  expect(isManagedAutoUpdateProcess({})).toBe(false);
  expect(isManagedAutoUpdateProcess({ AIO_PROXY_MANAGED: '1' })).toBe(true);
  expect(isManagedAutoUpdateProcess({ INVOCATION_ID: 'abc' }, { platform: 'linux', unitExists: () => true })).toBe(
    true,
  );
  expect(isManagedAutoUpdateProcess({ INVOCATION_ID: 'abc' }, { platform: 'linux', unitExists: () => false })).toBe(
    false,
  );
  expect(isManagedAutoUpdateProcess({ XPC_SERVICE_NAME: 'com.aio-proxy.agent' }, { platform: 'darwin' })).toBe(true);
  expect(
    isManagedAutoUpdateProcess(
      { XPC_SERVICE_NAME: 'com.apple.Terminal' },
      { platform: 'darwin', unitExists: () => true },
    ),
  ).toBe(false);
});

test('applyUpdate pins the checked version and upgrades via the launched exec path', async () => {
  const upgrade = mock(
    async (options: { version?: string }, _print: unknown, deps: { resolveTarget: () => Promise<unknown> }) => {
      expect(options.version).toBe('1.10.0');
      expect(await deps.resolveTarget()).toEqual({ method: 'binary', path: '/opt/aio-proxy' });
      return 'installed' as const;
    },
  );
  const hooks = createCliAutoUpdateHooks({
    upgrade: upgrade as never,
    resolveExec: () => '/opt/aio-proxy',
    resolveTargetFrom: async (binPath) => ({ method: 'binary', path: binPath }),
  });
  expect(await hooks.applyUpdate('1.10.0')).toBe('installed');
  expect(upgrade).toHaveBeenCalledTimes(1);
});

test('pre-marker boot migration rewrites the unit with the stable launcher and does not restart', async () => {
  const written: { readonly os: string; readonly exec: string }[] = [];
  let restarted = 0;
  await migratePreMarkerManagedUnit({
    env: { INVOCATION_ID: 'abc' },
    platform: 'linux',
    unitExists: () => true,
    readUnit: () => '[Service]\nEnvironment="AIO_PROXY_HOME=/tmp"\n',
    resolveExec: () => '/opt/homebrew/Cellar/aio-proxy/0.3.0/bin/aio-proxy',
    writeManagedUnit: async (os, exec) => {
      written.push({ os, exec });
      return '/tmp/unit';
    },
    serviceRestart: async () => {
      restarted += 1;
    },
  });
  expect(written).toEqual([{ os: 'linux', exec: '/opt/homebrew/bin/aio-proxy' }]);
  expect(restarted).toBe(0);
});

test('pre-marker Darwin boot migration rewrites the unit and does not restart', async () => {
  const written: { readonly os: string; readonly exec: string }[] = [];
  let restarted = 0;
  await migratePreMarkerManagedUnit({
    env: { XPC_SERVICE_NAME: 'com.aio-proxy.agent' },
    platform: 'darwin',
    unitExists: () => true,
    readUnit: () => '<plist></plist>',
    resolveExec: () => '/usr/local/Cellar/aio-proxy/1.0.0/bin/aio-proxy',
    writeManagedUnit: async (os, exec) => {
      written.push({ os, exec });
      return '/tmp/plist';
    },
    serviceRestart: async () => {
      restarted += 1;
    },
  });
  expect(written).toEqual([{ os: 'darwin', exec: '/usr/local/bin/aio-proxy' }]);
  expect(restarted).toBe(0);
});

test('a unit that already has the marker is not rewritten', async () => {
  let writes = 0;
  await migratePreMarkerManagedUnit({
    env: { INVOCATION_ID: 'abc', AIO_PROXY_MANAGED: '1' },
    platform: 'linux',
    unitExists: () => true,
    readUnit: () => 'Environment="AIO_PROXY_MANAGED=1"\n',
    writeManagedUnit: async () => {
      writes += 1;
      return '/tmp/unit';
    },
    serviceRestart: async () => {
      throw new Error('must not restart');
    },
  });
  expect(writes).toBe(0);
});

import { expect, mock, test } from 'bun:test';

import { m } from '@aio-proxy/i18n';

import { createCliAutoUpdateHooks, isManagedAutoUpdateProcess, migratePreMarkerManagedUnit } from './auto-update-hooks';

const linuxSessionCgroup = '0::/user.slice/user-1000.slice/session.slice/session-3.scope\n';
const linuxManagedCgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/aio-proxy.service\n';
const linuxSubstringCgroup = '0::/user.slice/not-aio-proxy.service-extra/session-3.scope\n';

test('isManagedAutoUpdateProcess accepts the marker and this-job manager evidence', () => {
  expect(isManagedAutoUpdateProcess({})).toBe(false);
  expect(isManagedAutoUpdateProcess({ AIO_PROXY_MANAGED: '1' })).toBe(true);
  expect(
    isManagedAutoUpdateProcess(
      { INVOCATION_ID: 'abc' },
      { platform: 'linux', unitExists: () => true, readCgroup: () => linuxSessionCgroup },
    ),
  ).toBe(false);
  expect(isManagedAutoUpdateProcess({}, { platform: 'linux', readCgroup: () => linuxManagedCgroup })).toBe(true);
  expect(isManagedAutoUpdateProcess({}, { platform: 'linux', readCgroup: () => linuxSubstringCgroup })).toBe(false);
  expect(
    isManagedAutoUpdateProcess(
      { INVOCATION_ID: 'abc' },
      { platform: 'linux', unitExists: () => false, readCgroup: () => undefined },
    ),
  ).toBe(false);
  expect(isManagedAutoUpdateProcess({}, { platform: 'linux', readCgroup: () => undefined })).toBe(false);
  expect(isManagedAutoUpdateProcess({}, { platform: 'linux', readCgroup: () => '' })).toBe(false);
  expect(
    isManagedAutoUpdateProcess(
      {},
      {
        platform: 'linux',
        readCgroup: () => {
          throw new Error('unreadable');
        },
      },
    ),
  ).toBe(false);
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
    isManagedService: () => true,
    upgrade: upgrade as never,
    resolveExec: () => '/opt/aio-proxy',
    resolveTargetFrom: async (binPath) => ({ method: 'binary', path: binPath }),
  });
  expect(await hooks.applyUpdate('1.10.0')).toBe('installed');
  expect(upgrade).toHaveBeenCalledTimes(1);
});

test('unmanaged applyUpdate relaunches this process after install', async () => {
  let relaunched = 0;
  const hooks = createCliAutoUpdateHooks({
    isManagedService: () => false,
    upgrade: mock(async () => 'installed' as const) as never,
    resolveExec: () => '/opt/aio-proxy',
    resolveTargetFrom: async (binPath) => ({ method: 'binary', path: binPath }),
    relaunchUnmanaged: () => {
      relaunched += 1;
    },
  });
  expect(await hooks.applyUpdate('1.10.0')).toBe('installed');
  expect(relaunched).toBe(1);
});

test('managed applyUpdate leaves restart to the service manager', async () => {
  let relaunched = 0;
  const hooks = createCliAutoUpdateHooks({
    isManagedService: () => true,
    upgrade: mock(async () => 'installed' as const) as never,
    resolveExec: () => '/opt/aio-proxy',
    resolveTargetFrom: async (binPath) => ({ method: 'binary', path: binPath }),
    relaunchUnmanaged: () => {
      relaunched += 1;
    },
  });
  expect(await hooks.applyUpdate('1.10.0')).toBe('installed');
  expect(relaunched).toBe(0);
});

test('unmanaged applyUpdate does not print the manual restart hint', async () => {
  const printed: string[] = [];
  const hooks = createCliAutoUpdateHooks({
    isManagedService: () => false,
    upgrade: mock(async (_options, print: (line: string) => void) => {
      print(m['cli.upgrade.manual_restart_hint']());
      print('installed 1.10.0');
      return 'installed' as const;
    }) as never,
    resolveExec: () => '/opt/aio-proxy',
    resolveTargetFrom: async (binPath) => ({ method: 'binary', path: binPath }),
    relaunchUnmanaged: () => {},
    print: (line) => {
      printed.push(line);
    },
  });
  expect(await hooks.applyUpdate('1.10.0')).toBe('installed');
  expect(printed).toEqual(['installed 1.10.0']);
  expect(printed.join('\n')).not.toContain(
    'The daemon was started manually; there is no managed service to restart. Restart it yourself to apply the upgrade',
  );
});

test('unchanged applyUpdate does not relaunch', async () => {
  let relaunched = 0;
  const hooks = createCliAutoUpdateHooks({
    isManagedService: () => false,
    upgrade: mock(async () => 'unchanged' as const) as never,
    resolveExec: () => '/opt/aio-proxy',
    resolveTargetFrom: async (binPath) => ({ method: 'binary', path: binPath }),
    relaunchUnmanaged: () => {
      relaunched += 1;
    },
  });
  expect(await hooks.applyUpdate('1.10.0')).toBe('unchanged');
  expect(relaunched).toBe(0);
});

test('pre-marker boot migration rewrites the unit with the stable launcher and does not restart', async () => {
  const written: { readonly os: string; readonly exec: string }[] = [];
  let restarted = 0;
  await migratePreMarkerManagedUnit({
    env: { INVOCATION_ID: 'abc' },
    platform: 'linux',
    unitExists: () => true,
    readCgroup: () => linuxManagedCgroup,
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

test('pre-marker Linux session invocation does not rewrite when this process is not aio-proxy.service', async () => {
  let writes = 0;
  await migratePreMarkerManagedUnit({
    env: { INVOCATION_ID: 'abc' },
    platform: 'linux',
    unitExists: () => true,
    readCgroup: () => linuxSessionCgroup,
    readUnit: () => '[Service]\nEnvironment="AIO_PROXY_HOME=/tmp"\n',
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

test('pre-marker unit read failures do not reject', async () => {
  await migratePreMarkerManagedUnit({
    env: { INVOCATION_ID: 'abc' },
    platform: 'linux',
    readCgroup: () => linuxManagedCgroup,
    readUnit: () => {
      throw new Error('unreadable');
    },
    writeManagedUnit: async () => {
      throw new Error('must not write');
    },
  });
});

test('pre-marker rewrite failures do not reject', async () => {
  await migratePreMarkerManagedUnit({
    env: { INVOCATION_ID: 'abc' },
    platform: 'linux',
    readCgroup: () => linuxManagedCgroup,
    readUnit: () => '[Service]\nEnvironment="AIO_PROXY_HOME=/tmp"\n',
    writeManagedUnit: async () => {
      throw new Error('daemon-reload failed');
    },
  });
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

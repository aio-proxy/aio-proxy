import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentManagedMarkerSchema } from '@aio-proxy/types';

import { installManagedIntegration } from './install';
import { fixtureRoots, installFixture, openCodeEntry, validState } from './test-fixture';

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('first configure writes files, marker, and fixed OpenCode entry', async () => {
  const f = await installFixture('opencode');
  await expect(installManagedIntegration(f.input, f.deps)).resolves.toBe('installed');
  expect(await Bun.file(join(f.location.managedDir, 'index.js')).text()).toBe('built-opencode');
  expect(await Bun.file(f.location.adjacentEntry!).text()).toBe(openCodeEntry(f.installationId));
  expect(
    AgentManagedMarkerSchema.parse(await Bun.file(join(f.location.managedDir, '.aio-proxy-managed.json')).json()),
  ).toMatchObject({ installationId: f.installationId, endpoint: 'http://127.0.0.1:9317' });
});

test('update preserves only a valid schema-1 state and keeps installation identity', async () => {
  const f = await installFixture('pi', { existing: true, state: validState() });
  await installManagedIntegration({ ...f.input, requestedInstallationId: crypto.randomUUID() }, f.deps);
  expect(await Bun.file(join(f.location.managedDir, '.aio-proxy-state.json')).json()).toEqual(validState());
  await expect(Bun.file(join(f.location.managedDir, '.aio-proxy-managed.json')).json()).resolves.toMatchObject({
    installationId: f.installationId,
  });
  expect(await Bun.file(join(f.location.managedDir, 'user-edit.txt')).exists()).toBe(false);
});

test('newer adapter exits without reading assets or writing', async () => {
  const f = await installFixture('omp', { existing: true, adapterVersion: '9.0.0' });
  await expect(installManagedIntegration(f.input, f.deps)).resolves.toBe('newer');
  expect(f.readAssets).not.toHaveBeenCalled();
  expect(await f.tree()).toEqual(f.beforeTree);
});

test('newer OpenCode adapter repairs only a missing fixed entry', async () => {
  const f = await installFixture('opencode', {
    existing: true,
    adapterVersion: '9.0.0',
    missingEntry: true,
  });
  const oldAdapter = await Bun.file(join(f.location.managedDir, 'old.js')).text();
  await expect(installManagedIntegration(f.input, f.deps)).resolves.toBe('newer');
  expect(f.readAssets).not.toHaveBeenCalled();
  expect(await Bun.file(f.location.adjacentEntry!).text()).toBe(openCodeEntry(f.installationId));
  expect(await Bun.file(join(f.location.managedDir, 'old.js')).text()).toBe(oldAdapter);
});

test('a target replaced while staging is fixed as backup and rejected before promotion', async () => {
  const f = await installFixture('pi', { existing: true });
  const displaced = join(f.root, 'concurrent-original');
  await expect(
    installManagedIntegration(f.input, {
      failpoint: async (point) => {
        if (point !== 'staged') return;
        await rename(f.location.managedDir, displaced);
        await mkdir(f.location.managedDir);
        await writeFile(join(f.location.managedDir, 'foreign.txt'), 'concurrent replacement');
      },
    }),
  ).rejects.toThrow('managed');
  expect(await Bun.file(join(f.location.managedDir, 'foreign.txt')).text()).toBe('concurrent replacement');
  expect(await Bun.file(join(displaced, 'old.js')).text()).toBe('old-adapter');
  expect(await Bun.file(join(f.location.managedDir, 'index.js')).exists()).toBe(false);
});

test.each(['file', 'symlink'] as const)('a concurrently created managed-path %s is preserved', async (kind) => {
  const f = await installFixture('pi');
  const foreign = join(f.root, 'foreign');
  await expect(
    installManagedIntegration(f.input, {
      failpoint: async (point) => {
        if (point !== 'staged') return;
        if (kind === 'file') await writeFile(f.location.managedDir, 'foreign file');
        else {
          await mkdir(foreign);
          await symlink(foreign, f.location.managedDir, 'dir');
        }
      },
    }),
  ).rejects.toThrow();
  if (kind === 'file') expect(await Bun.file(f.location.managedDir).text()).toBe('foreign file');
  else expect((await lstat(f.location.managedDir)).isSymbolicLink()).toBe(true);
});

test.each(['file', 'symlink'] as const)('a concurrently created OpenCode entry %s is never replaced', async (kind) => {
  const f = await installFixture('opencode');
  const foreign = join(f.root, 'foreign-entry.js');
  await writeFile(foreign, 'foreign entry');
  await expect(
    installManagedIntegration(f.input, {
      failpoint: async (point) => {
        if (point !== 'entry_ready') return;
        if (kind === 'file') await writeFile(f.location.adjacentEntry!, 'foreign entry');
        else await symlink(foreign, f.location.adjacentEntry!, 'file');
      },
    }),
  ).rejects.toThrow('entry');
  expect(await Bun.file(f.location.adjacentEntry!).text()).toBe('foreign entry');
  if (kind === 'symlink') expect((await lstat(f.location.adjacentEntry!)).isSymbolicLink()).toBe(true);
});

test.each(['stage write', 'directory swap', 'OpenCode entry write'] as const)(
  '%s failure restores the exact previous tree',
  async (failure) => {
    const f = await installFixture('opencode', { existing: true, failure });
    await expect(installManagedIntegration(f.input, f.deps)).rejects.toThrow();
    expect(await f.tree()).toEqual(f.beforeTree);
  },
);

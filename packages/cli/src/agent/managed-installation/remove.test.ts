import { afterEach, expect, test } from 'bun:test';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as managedInstallation from './index';
import { removeManagedIntegration, removeManagedIntegrationForTest, type ManagedRemoveTestDeps } from './remove';
import {
  displaceAndReplaceDir,
  displaceAndReplaceFile,
  fixtureRoots,
  openCodeEntry,
  removeFixture,
} from './test-fixture';

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('public remove failpoints accept a brief-union callback', () => {
  const failpoint = (_point: 'content_removed') => {};
  ({ failpoint }) satisfies ManagedRemoveTestDeps;
  expect('removeManagedIntegrationForTest' in managedInstallation).toBe(false);
});

test('remove refuses an entry conflict before deleting any byte', async () => {
  const f = await removeFixture('opencode', { conflictingEntry: true });
  await expect(removeManagedIntegration(f.location, f.installationId)).rejects.toThrow('entry');
  expect(await f.tree()).toEqual(f.beforeTree);
});

test('partial deletion keeps the ownership marker and a retry completes', async () => {
  const f = await removeFixture('pi');
  const marker = join(f.location.managedDir, '.aio-proxy-managed.json');
  await expect(
    removeManagedIntegration(f.location, f.installationId, {
      failpoint: (point) => {
        if (point === 'content_removed') throw new Error('partial delete');
      },
    }),
  ).rejects.toThrow('partial delete');
  expect(await Bun.file(marker).exists()).toBe(true);
  await expect(removeManagedIntegration(f.location, f.installationId)).resolves.toBeUndefined();
  expect(await Bun.file(f.location.managedDir).exists()).toBe(false);
});

test('remove preserves a replaced managed directory', async () => {
  const f = await removeFixture('pi');
  const displaced = join(f.root, 'displaced-managed');
  await expect(
    removeManagedIntegrationForTest(f.location, f.installationId, {
      onValidated: async () => {
        await displaceAndReplaceDir(f.location.managedDir, displaced, 'foreign.txt', 'foreign managed');
      },
    }),
  ).rejects.toThrow('managed');
  expect(await Bun.file(join(f.location.managedDir, 'foreign.txt')).text()).toBe('foreign managed');
  expect(await Bun.file(join(displaced, 'old.js')).text()).toBe('old-adapter');
  expect(await Bun.file(join(displaced, '.aio-proxy-managed.json')).exists()).toBe(true);
});

test('remove preserves a replaced adjacent entry', async () => {
  const f = await removeFixture('opencode');
  const displaced = join(f.root, 'displaced-entry');
  await expect(
    removeManagedIntegrationForTest(f.location, f.installationId, {
      onValidated: async () => {
        await displaceAndReplaceFile(f.location.adjacentEntry!, displaced, openCodeEntry(f.installationId));
      },
    }),
  ).rejects.toThrow('entry');
  expect(await Bun.file(f.location.adjacentEntry!).text()).toBe(openCodeEntry(f.installationId));
  expect(await Bun.file(displaced).text()).toBe(openCodeEntry(f.installationId));
  expect(await Bun.file(join(f.location.managedDir, 'old.js')).text()).toBe('old-adapter');
  expect(await Bun.file(join(f.location.managedDir, '.aio-proxy-managed.json')).exists()).toBe(true);
});

test('remove preserves a replaced ownership marker before any deletion', async () => {
  const f = await removeFixture('opencode');
  const marker = join(f.location.managedDir, '.aio-proxy-managed.json');
  const displaced = join(f.root, 'displaced-marker');
  const foreignMarker = JSON.stringify({
    format: 1,
    managedBy: 'aio-proxy',
    agent: 'opencode',
    installationId: crypto.randomUUID(),
    adapterVersion: '1.0.0',
    endpoint: 'http://127.0.0.1:9317',
  });
  await expect(
    removeManagedIntegrationForTest(f.location, f.installationId, {
      onValidated: async () => {
        await displaceAndReplaceFile(marker, displaced, foreignMarker);
      },
    }),
  ).rejects.toThrow('marker');
  expect(await Bun.file(f.location.adjacentEntry!).text()).toBe(openCodeEntry(f.installationId));
  expect(await Bun.file(join(f.location.managedDir, 'old.js')).text()).toBe('old-adapter');
  expect(await Bun.file(marker).text()).toBe(foreignMarker);
  expect(await Bun.file(displaced).exists()).toBe(true);
});

test('rmdir failure restores exact marker bytes and mode, then retry succeeds', async () => {
  const f = await removeFixture('pi');
  const marker = join(f.location.managedDir, '.aio-proxy-managed.json');
  const before = await readFile(marker);
  const mode = (await lstat(marker)).mode;
  await expect(
    removeManagedIntegration(f.location, f.installationId, {
      failpoint: async (point) => {
        if (point === 'content_removed') await writeFile(join(f.location.managedDir, 'blocker'), 'x');
      },
    }),
  ).rejects.toThrow();
  expect((await readFile(marker)).equals(before)).toBe(true);
  expect((await lstat(marker)).mode).toBe(mode);
  await expect(removeManagedIntegration(f.location, f.installationId)).resolves.toBeUndefined();
  expect(await Bun.file(f.location.managedDir).exists()).toBe(false);
});

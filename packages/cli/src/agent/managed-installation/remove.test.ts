import { afterEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { removeManagedIntegration } from './remove';
import { fixtureRoots, removeFixture } from './test-fixture';

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

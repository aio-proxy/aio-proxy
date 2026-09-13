import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeBackup } from './journal';

test('writeBackup fsyncs the backup directory after creating the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-backup-'));
  const directory = join(root, 'backups');
  const path = join(directory, '0.jsonl');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const probe = await open(directory, 'r');
  const directoryStat = await probe.stat();
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  const originalSync = proto.sync;
  let syncedDirectory = false;
  proto.sync = async function (this: { stat: () => ReturnType<typeof probe.stat> }) {
    const stat = await this.stat();
    if (stat.dev === directoryStat.dev && stat.ino === directoryStat.ino) syncedDirectory = true;
    return originalSync.call(this);
  };
  try {
    await writeBackup(path, new TextEncoder().encode('rollout\n'));
    expect(syncedDirectory).toBe(true);
    expect(await Bun.file(path).text()).toBe('rollout\n');
  } finally {
    proto.sync = originalSync;
    await probe.close();
    await rm(root, { recursive: true, force: true });
  }
});

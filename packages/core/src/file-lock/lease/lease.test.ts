import { expect, spyOn, test } from 'bun:test';
import { chmod, lstat, mkdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireProcessFileLock, observeProcessFileLock } from './lease';

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `aio-process-lease-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

test('serializes two processes and exposes only the live owner', async () => {
  const root = await temporaryRoot();
  const path = join(root, '.lock');
  const first = await acquireProcessFileLock(path);
  try {
    await expect(acquireProcessFileLock(path, AbortSignal.timeout(30))).rejects.toThrow();
    await expect(observeProcessFileLock(path)).resolves.toMatchObject({ owner: first.owner });
  } finally {
    await first.release();
  }
  await expect(observeProcessFileLock(path)).resolves.toBeUndefined();
});

test('reclaims a dead owner but blocks a live owner with an old heartbeat', async () => {
  const root = await temporaryRoot();
  const path = join(root, '.lock');
  await writeFile(
    path,
    JSON.stringify({ pid: 99999999, owner: 'dead', createdAt: Date.now() - 120_000, starttime: 'dead' }),
    { mode: 0o600 },
  );
  await utimes(path, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const reclaimed = await acquireProcessFileLock(path);
  await reclaimed.release();

  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, owner: 'live', createdAt: Date.now() - 120_000, starttime: 'unknown' }),
    { mode: 0o600 },
  );
  await utimes(path, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  await expect(acquireProcessFileLock(path, AbortSignal.timeout(30))).rejects.toThrow();
});

test('rejects unsafe lock symlinks and hard links', async () => {
  const root = await temporaryRoot();
  const target = join(root, 'target');
  const symlink = join(root, '.symlink-lock');
  const hardlink = join(root, '.hard-lock');
  await writeFile(target, 'x');
  await Bun.write(symlink, '');
  await Bun.$`ln -sf ${target} ${symlink}`;
  await expect(acquireProcessFileLock(symlink, AbortSignal.timeout(50))).rejects.toThrow();
  await writeFile(target, JSON.stringify({ pid: process.pid, owner: 'x', createdAt: Date.now(), starttime: 'x' }));
  await Bun.$`ln ${target} ${hardlink}`;
  await expect(acquireProcessFileLock(hardlink, AbortSignal.timeout(50))).rejects.toThrow(/hard|identity|Timed out/i);
  expect((await lstat(hardlink)).nlink).toBeGreaterThanOrEqual(1);
  await chmod(root, 0o700);
});

test('fence fails after replacement and cancellation aborts acquisition', async () => {
  const root = await temporaryRoot();
  const path = join(root, '.lock');
  const lock = await acquireProcessFileLock(path);
  await Bun.write(
    path,
    JSON.stringify({ pid: process.pid, owner: 'replacement', createdAt: Date.now(), starttime: 'x' }),
  );
  await expect(lock.withOwnership(async () => undefined)).rejects.toThrow(/ownership/i);
  await lock.release();

  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(acquireProcessFileLock(join(root, 'cancelled.lock'), controller.signal)).rejects.toThrow('cancelled');
});

test('recovers the exact owner after release cleanup fails', async () => {
  const root = await temporaryRoot();
  const path = join(root, '.lock');
  const realUnlink = fsPromises.unlink.bind(fsPromises);
  let failed = false;
  const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async (target) => {
    if (target === path && !failed) {
      failed = true;
      throw new Error('release failed');
    }
    return realUnlink(target);
  });
  try {
    const first = await acquireProcessFileLock(path);
    await expect(first.release()).rejects.toThrow('release failed');
    const abandoned = await readFile(path, 'utf8');
    const second = await acquireProcessFileLock(path, AbortSignal.timeout(500));
    expect(await readFile(path, 'utf8')).not.toBe(abandoned);
    await second.release();
  } finally {
    unlinkSpy.mockRestore();
    await unlink(path).catch(() => undefined);
  }
});

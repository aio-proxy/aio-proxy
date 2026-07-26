import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NpmLockError } from './error';
import { acquireNpmInstallLock } from './npm-lock';

describe.serial('acquireNpmInstallLock', () => {
  test('Given ps is unavailable When lock owner is alive Then lock is not recycled', async () => {
    // Given
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-live-lock-'));
    const lockPath = join(cacheDir, '.aio-proxy-install.lock');
    const lockText = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      starttime: 'different-starttime',
      version: 1,
    });
    writeFileSync(lockPath, lockText, { flag: 'wx' });
    const originalSpawn = Bun.spawn;
    Bun.spawn = () => {
      throw new Error('ps unavailable');
    };

    try {
      // When
      const result = acquireNpmInstallLock('aio-proxy-live-lock-provider', cacheDir, { waitMs: 100 });

      // Then
      await expect(result).rejects.toBeInstanceOf(NpmLockError);
      expect(readFileSync(lockPath, 'utf8')).toBe(lockText);
    } finally {
      Bun.spawn = originalSpawn;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('Given a fresh partial lock record When contending Then it receives a write grace period', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-partial-lock-'));
    const lockPath = join(cacheDir, '.aio-proxy-install.lock');
    writeFileSync(lockPath, '', { flag: 'wx' });
    let acquired = false;
    const pending = acquireNpmInstallLock('partial-lock-provider', cacheDir).then((lock) => {
      acquired = true;
      return lock;
    });

    await Bun.sleep(100);
    expect(acquired).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
    rmSync(lockPath);
    const lock = await pending;
    await lock.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test('Given unavailable identity and a live PID When heartbeat is stale Then the lock is recovered', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-reused-pid-lock-'));
    const lockPath = join(cacheDir, '.aio-proxy-install.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: 0,
        starttime: 'unavailable',
        version: 1,
      }),
      { flag: 'wx' },
    );
    utimesSync(lockPath, new Date(0), new Date(0));

    const pending = acquireNpmInstallLock('reused-pid-provider', cacheDir);
    let lock: Awaited<typeof pending> | undefined;
    try {
      lock = await Promise.race([
        pending,
        Bun.sleep(2_000).then(() => {
          throw new Error('stale npm lock with unavailable identity was not recovered');
        }),
      ]);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      if (lock === undefined) rmSync(lockPath, { force: true });
      lock ??= await pending.catch(() => undefined);
      await lock?.release();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('Given matching live identity and a stale heartbeat When contending Then the owner is preserved', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-stale-live-lock-'));
    const lockPath = join(cacheDir, '.aio-proxy-install.lock');
    const first = await acquireNpmInstallLock('stale-live-provider', cacheDir);
    utimesSync(lockPath, new Date(0), new Date(0));

    await expect(acquireNpmInstallLock('stale-live-provider', cacheDir, { waitMs: 100 })).rejects.toBeInstanceOf(
      NpmLockError,
    );
    await expect(first.withOwnership(async () => 'owned')).resolves.toBe('owned');
    expect(existsSync(lockPath)).toBe(true);

    await first.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });
});

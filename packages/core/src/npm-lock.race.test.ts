import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireNpmInstallLock } from './npm-lock';
import { waitForFile } from './npm-lock.test-support';

describe.serial('acquireNpmInstallLock', () => {
  test('Given concurrent stale-lock recovery When owners run Then only one lock is active', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-stale-lock-race-'));
    const lockPath = join(cacheDir, '.aio-proxy-install.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, createdAt: Date.now(), starttime: 'dead', version: 1 }), {
      flag: 'wx',
    });
    let active = 0;
    let maximum = 0;

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const lock = await acquireNpmInstallLock('stale-lock-race-provider', cacheDir, { waitMs: 30_000 });
        active += 1;
        maximum = Math.max(maximum, active);
        await Bun.sleep(10);
        active -= 1;
        await lock.release();
      }),
    );
    expect(maximum).toBe(1);
    rmSync(cacheDir, { recursive: true, force: true });
  }, 35_000);

  test('Given stale recovery paused after compare When owners change Then generations do not overlap', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-stale-generation-race-'));
    const lockPath = join(cacheDir, '.aio-proxy-install.lock');
    const pausedPath = join(cacheDir, 'recovery-paused');
    const resumePath = join(cacheDir, 'recovery-resume');
    const acquire = () => acquireNpmInstallLock('generation-race', cacheDir, { waitMs: 10_000 });
    const nativeSetInterval = globalThis.setInterval;
    let heartbeat = () => {};
    const intervals = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number) => {
      heartbeat = callback;
      return nativeSetInterval(callback, delay);
    }) as typeof setInterval);
    const first = await acquire();
    intervals.mockRestore();
    const probe = await fsPromises.open(join(cacheDir, 'probe'), 'w+');
    const utimes = spyOn(Object.getPrototypeOf(probe), 'utimes');
    await probe.close();
    utimesSync(lockPath, new Date(0), new Date(0));
    const originalSpawn = Bun.spawn;
    Bun.spawn = () => {
      throw new Error('ps unavailable');
    };
    const realRm = fsPromises.rm.bind(fsPromises);
    let intercepted = false;
    const rm = spyOn(fsPromises, 'rm').mockImplementation(async (target, options) => {
      if (target === lockPath && !intercepted) {
        intercepted = true;
        writeFileSync(pausedPath, 'paused');
        await waitForFile(resumePath);
      }
      return realRm(target, options);
    });
    let active = 0;
    let overlap = false;
    let markSecondStarted = () => {};
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    try {
      const secondPending = acquire().then(async (lock) => {
        try {
          return await lock.withOwnership(async () => {
            active += 1;
            overlap ||= active > 1;
            markSecondStarted();
            active -= 1;
            return 'owned';
          });
        } finally {
          await lock.release();
        }
      });
      await waitForFile(pausedPath);
      const heartbeatCalls = utimes.mock.calls.length;
      heartbeat();
      expect(utimes).toHaveBeenCalledTimes(heartbeatCalls);
      Bun.spawn = originalSpawn;
      const releasingFirst = first.release();
      await Bun.sleep(100);
      const thirdPending = acquire().then(async (lock) => {
        try {
          return await lock.withOwnership(async () => {
            active += 1;
            overlap ||= active > 1;
            await Promise.race([secondStarted, Bun.sleep(100)]);
            active -= 1;
            return 'owned';
          });
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        } finally {
          await lock.release();
        }
      });
      for (let attempt = 0; attempt < 20 && active === 0; attempt += 1) await Bun.sleep(5);
      writeFileSync(resumePath, 'resume');
      const [, , thirdOutcome] = await Promise.all([releasingFirst, secondPending, thirdPending]);
      expect({ overlap, thirdOutcome }).toEqual({ overlap: false, thirdOutcome: 'owned' });
    } finally {
      Bun.spawn = originalSpawn;
      markSecondStarted();
      writeFileSync(resumePath, 'resume');
      rm.mockRestore();
      utimes.mockRestore();
      await first.release().catch(() => {});
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 15_000);
});

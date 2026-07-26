import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireNpmInstallLock } from './npm-lock';
import { waitForFile } from './npm-lock.test-support';

describe.serial('acquireNpmInstallLock', () => {
  test('Given an owner releases within waitMs When contending Then the waiter acquires the lock', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-wait-budget-'));
    const first = await acquireNpmInstallLock('wait-budget-provider', cacheDir);
    const random = spyOn(Math, 'random').mockReturnValue(0);
    const pending = acquireNpmInstallLock('wait-budget-provider', cacheDir, { waitMs: 3_000 });
    void pending.catch(() => {});
    let second: Awaited<typeof pending> | undefined;

    try {
      await Bun.sleep(1_600);
      await first.release();
      second = await pending;
    } finally {
      random.mockRestore();
      await first.release().catch(() => {});
      await second?.release().catch(() => {});
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test('Given a stale decision When the owner refreshes heartbeat Then recovery preserves the owner', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'aio-proxy-refresh-during-recovery-'));
    const lockPath = join(cacheDir, '.aio-proxy-install.lock');
    const pausedPath = join(cacheDir, 'identity-paused');
    const resumePath = join(cacheDir, 'identity-resume');
    const first = await acquireNpmInstallLock('refresh-during-recovery-provider', cacheDir);
    utimesSync(lockPath, new Date(0), new Date(0));
    const ps = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(process.pid)], { stdout: 'pipe' });
    const starttime = new TextDecoder().decode(ps.stdout).trim();
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    const originalSpawn = mutableBun.spawn;
    let calls = 0;
    mutableBun.spawn = (() => {
      calls += 1;
      const stdout = new ReadableStream<Uint8Array>({
        async start(controller) {
          if (calls === 3) {
            writeFileSync(pausedPath, 'paused');
            await waitForFile(resumePath);
          }
          controller.enqueue(new TextEncoder().encode(`${starttime}\n`));
          controller.close();
        },
      });
      return { stdout, exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    let replacement: Awaited<ReturnType<typeof acquireNpmInstallLock>> | undefined;
    const pending = acquireNpmInstallLock('refresh-during-recovery-provider', cacheDir).then((lock) => {
      replacement = lock;
      return lock;
    });
    try {
      await waitForFile(pausedPath);
      const fresh = new Date();
      utimesSync(lockPath, fresh, fresh);
      writeFileSync(resumePath, 'resume');
      await Bun.sleep(100);
      await expect(first.withOwnership(async () => undefined)).resolves.toBeUndefined();
      expect(replacement).toBeUndefined();
      await first.release();
      replacement = await pending;
      await replacement.release();
    } finally {
      mutableBun.spawn = originalSpawn;
      writeFileSync(resumePath, 'resume');
      await first.release().catch(() => {});
      if (replacement === undefined) replacement = await pending.catch(() => undefined);
      await replacement?.release().catch(() => {});
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

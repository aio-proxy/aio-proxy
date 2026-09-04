import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithRecoveryFence } from './recovery-fence';

test.serial('reclaims a fresh malformed marker left by an interrupted publisher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-recovery-fence-'));
  const lockPath = join(dir, 'config.lock');
  const markerPath = `${lockPath}.recovery.interrupted`;
  writeFileSync(markerPath, '');
  try {
    await expect(
      runWithRecoveryFence(
        {
          lockPath,
          staleMs: 60_000,
          heartbeatMs: 10_000,
          deadline: Date.now() + 1_000,
          timeoutError: () => new Error('acquisition timed out'),
        },
        async () => 'acquired',
      ),
    ).resolves.toBe('acquired');
    expect(existsSync(markerPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.serial('acquisition filesystem errors are not translated after the deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-recovery-fence-'));
  const openError = new Error('recovery marker open failed');
  const open = spyOn(fsPromises, 'open').mockImplementation((async () => {
    await Bun.sleep(50);
    throw openError;
  }) as never);
  try {
    await expect(
      runWithRecoveryFence(
        {
          lockPath: join(dir, 'config.lock'),
          staleMs: 60_000,
          heartbeatMs: 10_000,
          deadline: Date.now() + 10,
          timeoutError: () => new Error('acquisition timed out'),
        },
        async () => undefined,
      ),
    ).rejects.toBe(openError);
  } finally {
    open.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.serial('action errors are not translated after the acquisition deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-recovery-fence-'));
  const originalSpawn = Bun.spawn;
  const spawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('MATCH\n'));
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
  })) as unknown as typeof Bun.spawn);
  const actionError = new Error('action failed');
  // The deadline must expire while the action runs, never during acquisition — a timeout there
  // is the translated-error path this test is not about. Acquisition gets a margin no loaded
  // runner needs all of, and the action outlives the deadline by construction rather than by
  // out-sleeping a fixed head start it might lose.
  const deadline = Date.now() + 1_000;
  try {
    await expect(
      runWithRecoveryFence(
        {
          lockPath: join(dir, 'config.lock'),
          staleMs: 60_000,
          heartbeatMs: 10_000,
          deadline,
          timeoutError: () => new Error('acquisition timed out'),
        },
        async () => {
          await Bun.sleep(Math.max(0, deadline - Date.now()) + 50);
          throw actionError;
        },
      ),
    ).rejects.toBe(actionError);
  } finally {
    spawn.mockRestore();
    Bun.spawn = originalSpawn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test.serial(
  'concurrent recovery acquisitions serialize without timing out',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-recovery-fence-'));
    const lockPath = join(dir, 'config.lock');
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, async () =>
          runWithRecoveryFence(
            {
              lockPath,
              staleMs: 60_000,
              heartbeatMs: 10_000,
              deadline: Date.now() + 10_000,
              timeoutError: () => new Error('acquisition timed out'),
            },
            async () => {
              await Bun.sleep(10);
              return 'ok';
            },
          ),
        ),
      );
      expect(results).toEqual(Array.from({ length: 8 }, () => 'ok'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

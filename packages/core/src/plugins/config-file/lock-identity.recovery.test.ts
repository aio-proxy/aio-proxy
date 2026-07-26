import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';

import { AtomicConfigFile } from '.';
import { ageLockWithUnavailableIdentity, fixture } from './test-support';

describe('AtomicConfigFile', () => {
  test('a main lock is recovered when its live PID has a different start identity', async () => {
    const { path } = fixture('{}\n');
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, owner: 'reused', createdAt: Date.now(), starttime: 'DIFFERENT' }),
    );
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => {
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('MATCH\n'));
          controller.close();
        },
      });
      return { stdout, exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    try {
      await new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ recovered: true });
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  test('a stale main lock with unavailable live identity is recovered', async () => {
    const { path } = fixture('{}\n');
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, owner: 'unknown', createdAt: 0, starttime: 'RECORDED' }),
    );
    ageLockWithUnavailableIdentity(lockPath);
    const originalSpawn = Bun.spawn;
    Bun.spawn = () => {
      throw new Error('ps unavailable');
    };
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
    try {
      await expect(
        Promise.race([
          update,
          Bun.sleep(500).then(() => {
            throw new Error('stale config lock with unavailable identity was not recovered');
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ recovered: true });
    } finally {
      Bun.spawn = originalSpawn;
      if (existsSync(lockPath)) unlinkSync(lockPath);
      await update.catch(() => {});
    }
  });

  test('a stale recovery fence with unavailable live identity is recovered', async () => {
    const { path } = fixture('{}\n');
    const recoveryPath = `${path}.lock.recovery.unknown-owner`;
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: 'unknown-owner', createdAt: 0 }));
    utimesSync(recoveryPath, new Date(0), new Date(0));
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
    try {
      await expect(
        Promise.race([
          update,
          Bun.sleep(500).then(() => {
            throw new Error('stale config recovery fence with unavailable identity was not recovered');
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(existsSync(recoveryPath)).toBe(false);
    } finally {
      if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
      await update.catch(() => {});
    }
  });
});

import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';

import { AtomicConfigFile, CONFIG_LOCK_WAIT_MS } from '.';
import { fixture } from './test-support';

describe('AtomicConfigFile', () => {
  test('a live recovery fence is never stolen because its heartbeat is old', async () => {
    const { path } = fixture('{}\n');
    const recoveryPath = `${path}.lock.recovery.live-owner`;
    const ps = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(process.pid)], { stdout: 'pipe' });
    const starttime = new TextDecoder().decode(ps.stdout).trim();
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: 'live-owner', createdAt: 0, starttime }));
    utimesSync(recoveryPath, new Date(0), new Date(0));

    let completed = false;
    const update = new AtomicConfigFile(path)
      .replace((current) => ({ ...current, recovered: true }))
      .then(() => {
        completed = true;
      });
    try {
      await Bun.sleep(100);
      expect(existsSync(recoveryPath)).toBe(true);
      expect(completed).toBe(false);
      unlinkSync(recoveryPath);
      await update;
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ recovered: true });
    } finally {
      if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
      await update.catch(() => {});
    }
  });

  test('a live recovery fence with unavailable identity returns a bounded timeout', async () => {
    const { path } = fixture('{}\n');
    const recoveryPath = `${path}.lock.recovery.unknown-owner`;
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: 'unknown-owner', createdAt: 0 }));
    const now = spyOn(Date, 'now');
    let tick = 0;
    now.mockImplementation(() => {
      tick += CONFIG_LOCK_WAIT_MS;
      return tick;
    });
    try {
      await expect(new AtomicConfigFile(path).replace((current) => current)).rejects.toThrow(
        'Timed out waiting for config recovery fence',
      );
      expect(existsSync(recoveryPath)).toBe(true);
    } finally {
      now.mockRestore();
      unlinkSync(recoveryPath);
    }
  });

  test.serial('config treats Windows lock owners as alive without probing the PID', async () => {
    const { path } = fixture('{}\n');
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, owner: 'windows-owner', createdAt: Date.now() }));
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('still owned')), 100);
    try {
      await expect(
        new AtomicConfigFile(path).replace((current) => ({ ...current, stolen: true }), { signal: controller.signal }),
      ).rejects.toThrow('still owned');
      expect(kill).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, 'utf8')).toContain('windows-owner');
    } finally {
      clearTimeout(timeout);
      kill.mockRestore();
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  test.serial('config treats non-Error liveness failures as alive', async () => {
    const { path } = fixture('{}\n');
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, owner: 'unknown-owner', createdAt: Date.now() }));
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      throw Symbol('kill-failure');
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('still owned')), 100);
    try {
      await expect(
        new AtomicConfigFile(path).replace((current) => ({ ...current, stolen: true }), { signal: controller.signal }),
      ).rejects.toThrow('still owned');
      expect(readFileSync(lockPath, 'utf8')).toContain('unknown-owner');
    } finally {
      clearTimeout(timeout);
      kill.mockRestore();
    }
  });
});

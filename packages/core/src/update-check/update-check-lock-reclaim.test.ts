import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observeLock, unlinkIfObserved } from './update-check-lock-reclaim';

const withTempLock = (run: (lockPath: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-lock-reclaim-'));
  const lockPath = join(dir, 'update-check.json.lock');
  try {
    run(lockPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('unlinkIfObserved removes the lock that was observed', () => {
  withTempLock((lockPath) => {
    writeFileSync(lockPath, '12345\nSat Jan  1 00:00:00 2000\n');
    const observed = observeLock(lockPath);
    expect(observed?.identity).toEqual({ pid: 12345, starttime: 'Sat Jan  1 00:00:00 2000' });
    unlinkIfObserved(lockPath, observed!);
    expect(existsSync(lockPath)).toBe(false);
  });
});

test('unlinkIfObserved does not remove a lock whose identity changed in place', () => {
  withTempLock((lockPath) => {
    writeFileSync(lockPath, '12345\nSat Jan  1 00:00:00 2000\n');
    const observed = observeLock(lockPath);
    expect(observed).toBeDefined();
    writeFileSync(lockPath, '999\nMon Jan  2 00:00:00 2000\n');
    unlinkIfObserved(lockPath, observed!);
    expect(readFileSync(lockPath, 'utf8')).toBe('999\nMon Jan  2 00:00:00 2000\n');
  });
});

test('unlinkIfObserved does not remove a lock that was replaced with a new inode', () => {
  withTempLock((lockPath) => {
    writeFileSync(lockPath, '12345\nSat Jan  1 00:00:00 2000\n');
    const observed = observeLock(lockPath);
    expect(observed).toBeDefined();
    rmSync(lockPath);
    writeFileSync(lockPath, '999\nMon Jan  2 00:00:00 2000\n');
    unlinkIfObserved(lockPath, observed!);
    expect(readFileSync(lockPath, 'utf8')).toBe('999\nMon Jan  2 00:00:00 2000\n');
  });
});

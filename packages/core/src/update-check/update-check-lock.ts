import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { updateCheckPath } from '../paths';

const STALE_MS = 30_000;
const RETRY_MS = 20;
const MAX_WAIT_MS = 5_000;

const tryUnlinkStale = (lockPath: string): void => {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) unlinkSync(lockPath);
  } catch {
    // Missing or unreadable lock: the next exclusive create decides.
  }
};

export const withUpdateCheckLock = async <T>(fn: () => Promise<T>, path: string = updateCheckPath()): Promise<T> => {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - started > MAX_WAIT_MS) tryUnlinkStale(lockPath);
      if (Date.now() - started > MAX_WAIT_MS + 1_000) throw error;
      await Bun.sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Another waiter may have already removed a stolen stale lock.
    }
  }
};

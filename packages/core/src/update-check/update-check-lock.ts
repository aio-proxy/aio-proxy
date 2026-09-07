import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { processIsAlive } from '../file-lock/process-identity';
import { updateCheckPath } from '../paths';

const RETRY_MS = 20;
const MAX_WAIT_MS = 5_000;

const readLockPid = (lockPath: string): number | undefined => {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const tryUnlinkIf = (lockPath: string, reclaimEmpty: boolean): void => {
  const pid = readLockPid(lockPath);
  if (pid !== undefined) {
    if (processIsAlive(pid)) return;
  } else if (!reclaimEmpty) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Another waiter won the unlink race.
  }
};

export const withUpdateCheckLock = async <T>(fn: () => Promise<T>, path: string = updateCheckPath()): Promise<T> => {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const started = Date.now();
  const owner = `${process.pid}\n`;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx');
      writeSync(fd, owner);
    } catch (error) {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
        try {
          unlinkSync(lockPath);
        } catch {
          // Lock path already gone.
        }
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const waited = Date.now() - started > MAX_WAIT_MS;
      tryUnlinkIf(lockPath, waited);
      if (Date.now() - started > MAX_WAIT_MS + 1_000) throw error;
      await Bun.sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    if (readLockPid(lockPath) === process.pid) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Another waiter may have already removed this lock.
      }
    }
  }
};

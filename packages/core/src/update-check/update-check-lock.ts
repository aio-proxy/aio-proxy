import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { processIsAlive, processStarttime } from '../file-lock/process-identity';
import { updateCheckPath } from '../paths';

const RETRY_MS = 20;
const MAX_WAIT_MS = 5_000;

type LockIdentity = {
  readonly pid: number;
  readonly starttime?: string;
};

const readLockIdentity = (lockPath: string): LockIdentity | undefined => {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const firstNl = raw.indexOf('\n');
    const pidLine = (firstNl === -1 ? raw : raw.slice(0, firstNl)).trim();
    const pid = Number.parseInt(pidLine, 10);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const starttime = firstNl === -1 ? '' : raw.slice(firstNl + 1).trim();
    return starttime === '' ? { pid } : { pid, starttime };
  } catch {
    return undefined;
  }
};

const tryUnlinkIf = async (lockPath: string, reclaimEmpty: boolean, skipStarttime: boolean): Promise<boolean> => {
  const identity = readLockIdentity(lockPath);
  if (identity !== undefined) {
    if (processIsAlive(identity.pid)) {
      if (identity.starttime === undefined || skipStarttime) return true;
      const live = await processStarttime(identity.pid);
      if (live === null || live === identity.starttime) return true;
    }
  } else if (!reclaimEmpty) {
    return false;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Another waiter won the unlink race.
  }
  return false;
};

export const withUpdateCheckLock = async <T>(fn: () => Promise<T>, path: string = updateCheckPath()): Promise<T> => {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const starttime = (await processStarttime(process.pid)) ?? undefined;
  const payload = starttime === undefined ? `${process.pid}\n` : `${process.pid}\n${starttime}\n`;
  const started = Date.now();
  let fd: number | undefined;
  let liveOwnerVerified = false;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx');
      writeSync(fd, payload);
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
      liveOwnerVerified = (await tryUnlinkIf(lockPath, waited, liveOwnerVerified)) || liveOwnerVerified;
      if (Date.now() - started > MAX_WAIT_MS + 1_000) throw error;
      await Bun.sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    const current = readLockIdentity(lockPath);
    if (current?.pid === process.pid && current.starttime === starttime) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Another waiter may have already removed this lock.
      }
    }
  }
};

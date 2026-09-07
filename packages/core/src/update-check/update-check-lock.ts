import { closeSync, fstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { processIsAlive, processStarttime } from '../file-lock/process-identity';
import { updateCheckPath } from '../paths';
import { observeLock, parseLockIdentity, unlinkIfObserved } from './update-check-lock-reclaim';

const RETRY_MS = 20;
const MAX_WAIT_MS = 5_000;

const tryUnlinkIf = async (lockPath: string, reclaimEmpty: boolean, skipStarttime: boolean): Promise<boolean> => {
  const observed = observeLock(lockPath);
  if (observed === undefined) {
    if (!reclaimEmpty) return false;
    try {
      unlinkSync(lockPath);
    } catch {
      // Another waiter won the unlink race.
    }
    return false;
  }
  const owner = observed.identity;
  if (owner !== undefined) {
    if (processIsAlive(owner.pid)) {
      if (owner.starttime === undefined || skipStarttime) return true;
      const live = await processStarttime(owner.pid);
      if (live === null || live === owner.starttime) return true;
    }
  } else if (!reclaimEmpty) {
    return false;
  }
  unlinkIfObserved(lockPath, observed);
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
        let held: ReturnType<typeof fstatSync> | undefined;
        try {
          held = fstatSync(fd);
        } catch {
          held = undefined;
        }
        closeSync(fd);
        fd = undefined;
        if (held !== undefined) {
          unlinkIfObserved(lockPath, { identity: parseLockIdentity(payload), dev: held.dev, ino: held.ino });
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
    const held = fstatSync(fd);
    closeSync(fd);
    unlinkIfObserved(lockPath, {
      identity: { pid: process.pid, ...(starttime === undefined ? {} : { starttime }) },
      dev: held.dev,
      ino: held.ino,
    });
  }
};

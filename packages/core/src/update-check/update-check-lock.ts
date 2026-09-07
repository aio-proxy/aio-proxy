import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import * as processIdentity from '../file-lock/process-identity';
import { updateCheckPath } from '../paths';

const RETRY_MS = 20;
const MAX_WAIT_MS = 5_000;

type LockIdentity = {
  readonly pid: number;
  readonly starttime?: string;
};

type LockObservation = {
  readonly identity: LockIdentity | undefined;
  readonly dev: number;
  readonly ino: number;
};

const parseLockIdentity = (raw: string): LockIdentity | undefined => {
  const firstNl = raw.indexOf('\n');
  const pidLine = (firstNl === -1 ? raw : raw.slice(0, firstNl)).trim();
  const pid = Number.parseInt(pidLine, 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const starttime = firstNl === -1 ? '' : raw.slice(firstNl + 1).trim();
  return starttime === '' ? { pid } : { pid, starttime };
};

const readLockIdentity = (lockPath: string): LockIdentity | undefined => {
  try {
    return parseLockIdentity(readFileSync(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
};

const observeLock = (lockPath: string): LockObservation | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, 'r');
    const st = fstatSync(fd);
    const identity = parseLockIdentity(readFileSync(fd, 'utf8'));
    return { identity, dev: st.dev, ino: st.ino };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Observation fd is best-effort.
      }
    }
  }
};

const sameIdentity = (left: LockIdentity | undefined, right: LockIdentity | undefined): boolean =>
  left?.pid === right?.pid && left?.starttime === right?.starttime;

const unlinkIfObserved = (lockPath: string, observed: LockObservation): void => {
  try {
    const current = statSync(lockPath);
    if (current.dev !== observed.dev || current.ino !== observed.ino) return;
    if (!sameIdentity(readLockIdentity(lockPath), observed.identity)) return;
    unlinkSync(lockPath);
  } catch {
    // Replacement already moved the pathname.
  }
};

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
    if (processIdentity.processIsAlive(owner.pid)) {
      if (owner.starttime === undefined || skipStarttime) return true;
      const live = await processIdentity.processStarttime(owner.pid);
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
  const starttime = (await processIdentity.processStarttime(process.pid)) ?? undefined;
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

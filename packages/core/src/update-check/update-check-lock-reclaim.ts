import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';

export type LockIdentity = {
  readonly pid: number;
  readonly starttime?: string;
};

export type LockObservation = {
  readonly identity: LockIdentity | undefined;
  readonly dev: number;
  readonly ino: number;
};

export const parseLockIdentity = (raw: string): LockIdentity | undefined => {
  const firstNl = raw.indexOf('\n');
  const pidLine = (firstNl === -1 ? raw : raw.slice(0, firstNl)).trim();
  const pid = Number.parseInt(pidLine, 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const starttime = firstNl === -1 ? '' : raw.slice(firstNl + 1).trim();
  return starttime === '' ? { pid } : { pid, starttime };
};

export const readLockIdentity = (lockPath: string): LockIdentity | undefined => {
  try {
    return parseLockIdentity(readFileSync(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
};

export const observeLock = (lockPath: string): LockObservation | undefined => {
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

export const unlinkIfObserved = (lockPath: string, observed: LockObservation): void => {
  try {
    const current = statSync(lockPath);
    if (current.dev !== observed.dev || current.ino !== observed.ino) return;
    if (!sameIdentity(readLockIdentity(lockPath), observed.identity)) return;
    unlinkSync(lockPath);
  } catch {
    // Replacement already moved the pathname.
  }
};

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isRecord } from '@aio-proxy/types';

import { isNodeError } from '../../file-lock/fs';
import { processIsAlive, processStarttime } from '../../file-lock/process-identity';
import { runWithRecoveryFence } from '../../file-lock/recovery-fence';

const LOCK_VERSION = 1;
const LOCK_HEARTBEAT_MS = 10_000;
const STALE_LOCK_MS = 60_000;
const STARTTIME_UNAVAILABLE = 'unavailable';
const DEFAULT_WAIT_MS = 5_000;

type LockRecord = {
  readonly version: typeof LOCK_VERSION;
  readonly pid: number;
  readonly starttime: string;
  readonly owner: string;
  readonly createdAt: number;
};

export type DatabaseOwnershipLock = {
  readonly databasePath: string;
  readonly release: () => void;
};

export class DatabaseOwnershipError extends Error {
  constructor(readonly databasePath: string) {
    super(`Another aio-proxy server owns database: ${databasePath}`);
  }
}

export class DatabaseOwnershipPathError extends Error {
  constructor(
    readonly databasePath: string,
    readonly reason: 'symlink' | 'hardlink',
  ) {
    super(`Unsafe aio-proxy database path (${reason}): ${databasePath}`);
  }
}

export function assertSafeOwnedDatabaseFile(databasePath: string): void {
  let metadata: Stats;
  try {
    metadata = lstatSync(databasePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new DatabaseOwnershipPathError(databasePath, 'symlink');
  }
  if (statSync(databasePath).nlink !== 1) {
    throw new DatabaseOwnershipPathError(databasePath, 'hardlink');
  }
}

export async function acquireDatabaseOwnershipLock(
  databasePath: string,
  options?: { readonly waitMs?: number },
): Promise<DatabaseOwnershipLock> {
  const canonicalDatabasePath = prepareCanonicalDatabasePath(databasePath);
  const lockPath = `${canonicalDatabasePath}.server.lock`;
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const starttime = (await processStarttime(process.pid)) ?? STARTTIME_UNAVAILABLE;
  const owner = randomUUID();
  const content = JSON.stringify({
    version: LOCK_VERSION,
    pid: process.pid,
    starttime,
    owner,
    createdAt: Date.now(),
  } satisfies LockRecord);

  while (true) {
    const acquired = tryExclusiveCreate(lockPath, content);
    if (acquired !== null) {
      return createLockHandle(canonicalDatabasePath, lockPath, owner, acquired);
    }

    const inspection = await inspectLock(lockPath);
    if (!inspection.stale) {
      throw new DatabaseOwnershipError(canonicalDatabasePath);
    }
    if (inspection.text !== undefined && inspection.identity !== undefined) {
      const staleText = inspection.text;
      const staleIdentity = inspection.identity;
      const removed = await runWithRecoveryFence(
        {
          lockPath,
          staleMs: STALE_LOCK_MS,
          heartbeatMs: LOCK_HEARTBEAT_MS,
          deadline,
          timeoutError: () => new DatabaseOwnershipError(canonicalDatabasePath),
        },
        async (assertFence) => {
          await assertFence();
          return removeIfUnchanged(lockPath, staleText, staleIdentity);
        },
      );
      if (removed) continue;
    } else {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new DatabaseOwnershipError(canonicalDatabasePath);
    }
    await Bun.sleep(Math.min(25, Math.max(0, deadline - Date.now())));
  }
}

function prepareCanonicalDatabasePath(databasePath: string): string {
  const parent = dirname(databasePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(parent, 0o700);
  }
  const canonicalDatabasePath = join(realpathSync.native(parent), basename(databasePath));
  assertSafeOwnedDatabaseFile(canonicalDatabasePath);
  return canonicalDatabasePath;
}

function tryExclusiveCreate(lockPath: string, content: string): number | null {
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return null;
    throw error;
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {}
    throw error;
  }
}

function createLockHandle(databasePath: string, lockPath: string, owner: string, fd: number): DatabaseOwnershipLock {
  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    try {
      const now = new Date();
      futimesSync(fd, now, now);
    } catch {}
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  let released = false;
  return {
    databasePath,
    release() {
      if (released) return;
      released = true;
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      try {
        const record = parseLock(readFileSync(lockPath, 'utf8'));
        const current = statSync(lockPath);
        const held = fstatSync(fd);
        if (record?.owner === owner && current.dev === held.dev && current.ino === held.ino) {
          unlinkSync(lockPath);
        }
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }
    },
  };
}

function parseLock(text: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const { version, pid, starttime, owner, createdAt } = value as Record<string, unknown>;
    return version === LOCK_VERSION &&
      typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      typeof starttime === 'string' &&
      typeof owner === 'string' &&
      typeof createdAt === 'number'
      ? { version: LOCK_VERSION, pid, starttime, owner, createdAt }
      : null;
  } catch {
    return null;
  }
}

async function inspectLock(
  lockPath: string,
): Promise<{ readonly stale: false } | { readonly stale: true; readonly text?: string; readonly identity?: Stats }> {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { stale: true };
    throw error;
  }
  const record = parseLock(text);
  let metadata: Stats;
  try {
    metadata = statSync(lockPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { stale: true };
    throw error;
  }
  const staleByHeartbeat = Date.now() - metadata.mtimeMs > STALE_LOCK_MS;
  const ownerAlive = record !== null && processIsAlive(record.pid);
  const ownerStarttime = record === null || !ownerAlive ? null : await processStarttime(record.pid);
  const identityVerifiable =
    ownerAlive && record !== null && record.starttime !== STARTTIME_UNAVAILABLE && ownerStarttime !== null;
  const stale =
    record === null
      ? staleByHeartbeat
      : !ownerAlive || (identityVerifiable ? ownerStarttime !== record.starttime : staleByHeartbeat);
  return stale ? { stale: true, text, identity: metadata } : { stale: false };
}

function removeIfUnchanged(lockPath: string, expected: string, identity: Stats): boolean {
  try {
    if (readFileSync(lockPath, 'utf8') !== expected) return false;
    const current = statSync(lockPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    throw error;
  }
}

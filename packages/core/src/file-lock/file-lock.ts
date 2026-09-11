import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import { clearAbandonedLock, isAbandonedLock, reclaimAbandonedLock, rememberAbandonedLock } from './abandoned-owner';
import { abortableDelay } from './delay';
import { isNodeError, sameFileSnapshot } from './fs';
import { processIsAlive, processStarttime } from './process-identity';
import { MAX_LOCK_RECORD_BYTES, readLockPathText, readLockRecordText } from './read-lock-text';
import { runWithRecoveryFence } from './recovery-fence';

const FILE_LOCK_WAIT_MS = 15_000;
const FILE_LOCK_STALE_MS = 60_000;
const FILE_LOCK_HEARTBEAT_MS = 10_000;
// acquireFileLock creates the file before writing JSON. Fresh empty/malformed
// records are a write race; older ones are abandoned leftovers.
const FILE_LOCK_WRITE_GRACE_MS = 250;

export type FileLockOptions = {
  readonly deadline?: number;
  readonly signal?: AbortSignal;
};

export type FileLock = {
  readonly owner: string;
  withOwnership<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T>;
  withOwnershipFence<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T>;
  release(): Promise<void>;
};

type LockRecord = {
  readonly pid: number;
  readonly owner: string;
  readonly createdAt: number;
  readonly starttime?: string;
};

function lockOwnerIsAlive(pid: number): boolean {
  if (process.platform === 'win32') return true;
  try {
    return processIsAlive(pid);
  } catch {
    return true;
  }
}

function parseLock(text: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return null;
    const { pid, owner, createdAt, starttime } = value as Record<string, unknown>;
    return typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      typeof owner === 'string' &&
      typeof createdAt === 'number' &&
      (starttime === undefined || typeof starttime === 'string')
      ? { pid, owner, createdAt, ...(starttime === undefined ? {} : { starttime }) }
      : null;
  } catch {
    return null;
  }
}

async function readLock(path: string, options: FileLockOptions = {}): Promise<LockRecord | null> {
  try {
    return parseLock(
      await readLockPathText(path, {
        maxBytes: MAX_LOCK_RECORD_BYTES,
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    if (
      error instanceof Error &&
      (error.message === 'lock record too large' || error.message === 'lock record read timed out')
    ) {
      lockReadError(path, error);
    }
    return null;
  }
}

function lifetimeSignal(options: FileLockOptions, lifetimeDeadline: number | undefined): AbortSignal | undefined {
  if (lifetimeDeadline === undefined) return options.signal;
  return AbortSignal.any([
    ...(options.signal === undefined ? [] : [options.signal]),
    AbortSignal.timeout(Math.max(0, lifetimeDeadline - Date.now())),
  ]);
}

async function withLockRecoveryFence<T>(
  lockPath: string,
  action: (assertFence: () => Promise<void>) => Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  return runWithRecoveryFence(
    {
      lockPath,
      staleMs: FILE_LOCK_STALE_MS,
      heartbeatMs: FILE_LOCK_HEARTBEAT_MS,
      deadline,
      timeoutError: () => new Error(`Timed out waiting for file lock recovery fence: ${lockPath}`),
      ownerIsAlive: lockOwnerIsAlive,
      ...(signal === undefined ? {} : { signal }),
    },
    action,
  );
}

async function unlinkMatchingInode(path: string, identity: Stats, assertFence: () => Promise<void>): Promise<void> {
  try {
    const metadata = await stat(path);
    if (metadata.dev !== identity.dev || metadata.ino !== identity.ino) return;
    await assertFence();
    const currentMetadata = await stat(path);
    if (currentMetadata.dev !== identity.dev || currentMetadata.ino !== identity.ino) return;
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function unlinkOwnedLock(
  path: string,
  owner: string,
  identity: Stats,
  assertFence: () => Promise<void>,
  options: FileLockOptions = {},
): Promise<void> {
  try {
    const [record, metadata] = await Promise.all([readLock(path, options), stat(path)]);
    if (record?.owner !== owner || metadata.dev !== identity.dev || metadata.ino !== identity.ino) return;
    await assertFence();
    const [currentRecord, currentMetadata] = await Promise.all([readLock(path, options), stat(path)]);
    if (
      currentRecord?.owner !== owner ||
      currentMetadata.dev !== identity.dev ||
      currentMetadata.ino !== identity.ino
    ) {
      return;
    }
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

function lockReadError(path: string, error: unknown): never {
  if (error instanceof Error && error.message === 'lock record too large') {
    throw new Error(`File lock record too large: ${path}`, { cause: error });
  }
  if (error instanceof Error && error.message === 'lock record read timed out') {
    throw new Error(`Timed out waiting for file lock: ${path}`, { cause: error });
  }
  throw error;
}

async function reclaimStaleLock(
  path: string,
  assertFence: () => Promise<void>,
  options: FileLockOptions = {},
): Promise<boolean> {
  const readOptions = {
    maxBytes: MAX_LOCK_RECORD_BYTES,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  let text: string;
  try {
    text = await readLockPathText(path, readOptions);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    lockReadError(path, error);
  }
  const [record, metadata] = await Promise.all([Promise.resolve(parseLock(text)), stat(path).catch(() => null)]);
  const staleByHeartbeat = metadata === null || Date.now() - metadata.mtimeMs > FILE_LOCK_STALE_MS;
  const staleByWriteGrace = metadata === null || Date.now() - metadata.mtimeMs > FILE_LOCK_WRITE_GRACE_MS;
  const alive = record !== null && lockOwnerIsAlive(record.pid);
  const currentStarttime = record === null || !alive ? null : await processStarttime(record.pid);
  const identityVerifiable = alive && record?.starttime !== undefined && currentStarttime !== null;
  const stale =
    record === null
      ? staleByWriteGrace
      : !alive || (identityVerifiable ? currentStarttime !== record.starttime : staleByHeartbeat);
  if (!stale || metadata === null) return false;
  try {
    await assertFence();
    let currentText: string;
    try {
      currentText = await readLockPathText(path, readOptions);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return true;
      lockReadError(path, error);
    }
    if (currentText !== text) return false;
    const currentMetadata = await stat(path);
    if (!sameFileSnapshot(metadata, currentMetadata)) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    throw error;
  }
}

function temporaryObservationError(path: string, reason: string, cause?: unknown): Error {
  return new Error(
    `temporary file lock observation failure (${reason}): ${path}`,
    cause === undefined ? undefined : { cause },
  );
}

function assertSafeLockMetadata(path: string, metadata: Stats): void {
  if (metadata.isSymbolicLink()) {
    throw temporaryObservationError(path, 'symlink');
  }
  if (!metadata.isFile()) {
    throw temporaryObservationError(path, 'not a regular file');
  }
  if (metadata.nlink !== 1) {
    throw temporaryObservationError(path, 'hardlink');
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw temporaryObservationError(path, 'owner');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw temporaryObservationError(path, 'permissions');
  }
}

export async function observeFileLockOwner(path: string, options: FileLockOptions = {}): Promise<string | undefined> {
  const lifetimeDeadline = options.deadline;
  const signal = lifetimeSignal(options, lifetimeDeadline);
  signal?.throwIfAborted();
  if (lifetimeDeadline !== undefined && Date.now() >= lifetimeDeadline) {
    throw new Error(`Timed out waiting for file lock: ${path}`);
  }

  let linkMetadata: Stats;
  try {
    linkMetadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
  assertSafeLockMetadata(path, linkMetadata);
  signal?.throwIfAborted();

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (isNodeError(error, 'ELOOP') || isNodeError(error, 'EPERM')) {
      throw temporaryObservationError(path, 'symlink', error);
    }
    throw error;
  }

  try {
    signal?.throwIfAborted();
    const fileMetadata = await handle.stat();
    if (fileMetadata.dev !== linkMetadata.dev || fileMetadata.ino !== linkMetadata.ino) {
      throw temporaryObservationError(path, 'identity mismatch');
    }
    assertSafeLockMetadata(path, fileMetadata);
    let text: string;
    try {
      text = await readLockRecordText(handle, fileMetadata.size, {
        maxBytes: MAX_LOCK_RECORD_BYTES,
        deadline: lifetimeDeadline,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'lock record too large') {
        throw temporaryObservationError(path, 'too large', error);
      }
      if (error instanceof Error && error.message === 'lock record read timed out') {
        throw new Error(`Timed out waiting for file lock: ${path}`, { cause: error });
      }
      throw error;
    }
    const record = parseLock(text);
    if (record === null) {
      if (Date.now() - fileMetadata.mtimeMs > FILE_LOCK_WRITE_GRACE_MS) return undefined;
      throw temporaryObservationError(path, 'malformed');
    }
    if (isAbandonedLock(path, { owner: record.owner, text, identity: fileMetadata })) {
      return undefined;
    }

    let alive: boolean;
    try {
      alive = process.platform === 'win32' ? true : processIsAlive(record.pid);
    } catch (error) {
      throw temporaryObservationError(path, 'liveness', error);
    }
    if (!alive) return undefined;

    signal?.throwIfAborted();
    const currentStarttime = await processStarttime(record.pid);
    signal?.throwIfAborted();
    if (lifetimeDeadline !== undefined && Date.now() >= lifetimeDeadline) {
      throw new Error(`Timed out waiting for file lock: ${path}`);
    }
    const identityVerifiable = record.starttime !== undefined && currentStarttime !== null;
    if (!identityVerifiable) {
      throw temporaryObservationError(path, 'identity');
    }
    if (currentStarttime !== record.starttime) return undefined;
    return record.owner;
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function acquireFileLock(path: string, options: FileLockOptions = {}): Promise<FileLock> {
  const lifetimeDeadline = options.deadline;
  const startedAt = Date.now();
  const acquireDeadline = lifetimeDeadline ?? startedAt + FILE_LOCK_WAIT_MS;
  const signal = lifetimeSignal(options, lifetimeDeadline);
  const fenceSignal = lifetimeDeadline === undefined ? undefined : signal;
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  const starttime = await processStarttime(process.pid);
  while (true) {
    signal?.throwIfAborted();
    const acquired = await withLockRecoveryFence(
      path,
      async (assertFence) => {
        try {
          const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          let identity: Stats | undefined;
          try {
            signal?.throwIfAborted();
            await assertFence();
            const text = JSON.stringify({
              pid: process.pid,
              owner,
              createdAt: Date.now(),
              ...(starttime === null ? {} : { starttime }),
            } satisfies LockRecord);
            signal?.throwIfAborted();
            await assertFence();
            await handle.writeFile(text);
            signal?.throwIfAborted();
            await assertFence();
            await handle.sync();
            signal?.throwIfAborted();
            await assertFence();
            identity = await handle.stat();
            await assertFence();
            clearAbandonedLock(path);
            return { handle, identity, text };
          } catch (error) {
            const createdIdentity = identity ?? (await handle.stat().catch(() => undefined));
            await handle.close().catch(() => {});
            if (createdIdentity !== undefined) {
              await unlinkMatchingInode(path, createdIdentity, assertFence).catch(() => {});
            }
            throw error;
          }
        } catch (error) {
          if (!isNodeError(error, 'EEXIST')) throw error;
          if (await reclaimAbandonedLock(path, assertFence, options)) return null;
          return (await reclaimStaleLock(path, assertFence, options)) ? null : false;
        }
      },
      acquireDeadline,
      signal,
    );
    if (acquired === null) continue;
    if (acquired === false) {
      if (Date.now() >= acquireDeadline) throw new Error(`Timed out waiting for file lock: ${path}`);
      await abortableDelay(50 + Math.floor(Math.random() * 25), signal);
      continue;
    }
    const { handle, identity, text } = acquired;
    let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      const now = new Date();
      void handle.utimes(now, now).catch(() => {});
    }, FILE_LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    const verifyOwnership = async () => {
      try {
        const [record, metadata] = await Promise.all([readLock(path, options), stat(path)]);
        if (record?.owner !== owner || metadata.dev !== identity.dev || metadata.ino !== identity.ino) {
          throw new Error('File lock ownership lost');
        }
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) throw new Error('File lock ownership lost');
        throw error;
      }
    };
    const assertOwnership = async () => {
      await verifyOwnership();
      const now = new Date();
      await handle.utimes(now, now);
    };
    const nextFenceDeadline = () => lifetimeDeadline ?? Date.now() + FILE_LOCK_WAIT_MS;
    return {
      owner,
      async withOwnership<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T> {
        await assertOwnership();
        return action(assertOwnership);
      },
      withOwnershipFence: <T>(action: (assertOwnership: () => Promise<void>) => Promise<T>) =>
        withLockRecoveryFence(
          path,
          async (assertFence) => {
            const assertFencedOwnership = async () => {
              await assertFence();
              await assertOwnership();
            };
            await assertFencedOwnership();
            return action(assertFencedOwnership);
          },
          nextFenceDeadline(),
          fenceSignal,
        ),
      async release() {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        try {
          await withLockRecoveryFence(
            path,
            (assertFence) => unlinkOwnedLock(path, owner, identity, assertFence, options),
            nextFenceDeadline(),
            fenceSignal,
          );
          clearAbandonedLock(path);
        } catch (error) {
          rememberAbandonedLock(path, { owner, identity, text });
          throw error;
        } finally {
          await handle.close().catch(() => {});
        }
      },
    };
  }
}

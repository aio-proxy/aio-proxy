import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { mkdir, open, lstat, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import { clearAbandonedOwner, reclaimAbandonedOwner, rememberAbandonedOwner } from '../abandoned-owner';
import { abortableDelay } from '../delay';
import { isNodeError } from '../fs';
import { processIsAlive, processStarttime } from '../process-identity';
import { runWithRecoveryFence } from '../recovery-fence';

const STALE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const WAIT_MS = 15_000;
const STARTTIME_UNAVAILABLE = 'unavailable';
const sameIdentity = (before: Stats, after: Stats): boolean => before.dev === after.dev && before.ino === after.ino;

type LockRecord = {
  readonly pid: number;
  readonly owner: string;
  readonly createdAt: number;
  readonly starttime: string;
};

export type ProcessFileLock = {
  readonly owner: string;
  readonly predecessor?: string;
  readonly withOwnership: <T>(action: (assertOwned: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly withOwnershipFence: <T>(action: (assertOwned: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly release: () => Promise<void>;
};

const parseRecord = (text: string): LockRecord | undefined => {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof value['pid'] !== 'number' ||
      !Number.isSafeInteger(value['pid']) ||
      typeof value['owner'] !== 'string' ||
      typeof value['createdAt'] !== 'number' ||
      typeof value['starttime'] !== 'string'
    )
      return undefined;
    return { pid: value['pid'], owner: value['owner'], createdAt: value['createdAt'], starttime: value['starttime'] };
  } catch {
    return undefined;
  }
};

async function assertSafePath(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    try {
      const parent = await lstat(current);
      if (parent.isSymbolicLink()) {
        if (current !== '/tmp' && current !== '/var') throw new Error(`Unsafe lock parent: ${current}`);
        continue;
      }
      if (current !== absolute && !parent.isDirectory()) throw new Error(`Unsafe lock parent: ${current}`);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) break;
      throw error;
    }
  }
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink()) throw new Error(`Refusing symbolic lock: ${path}`);
    if (current.nlink > 1) throw new Error(`Refusing hard-linked lock: ${path}`);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function ownerIsStale(path: string): Promise<{ stale: boolean; text?: string; identity?: Stats }> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { stale: true };
    throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Refusing symbolic lock: ${path}`);
  if (metadata.nlink > 1) throw new Error(`Refusing hard-linked lock: ${path}`);
  const record = parseRecord(text);
  if (record === undefined) {
    return Date.now() - metadata.mtimeMs > STALE_MS
      ? { stale: true, text, identity: metadata }
      : { stale: false, text };
  }
  let alive = false;
  try {
    alive = processIsAlive(record.pid);
  } catch {
    alive = true;
  }
  const currentStarttime = alive ? await processStarttime(record.pid) : null;
  const identityVerifiable = alive && currentStarttime !== null && record.starttime !== STARTTIME_UNAVAILABLE;
  // A live process with an unverifiable start time is conservatively retained.
  // An expired heartbeat alone cannot prove that a live owner abandoned the lock.
  const stale = !alive || (identityVerifiable ? currentStarttime !== record.starttime : false);
  return stale ? { stale: true, text, identity: metadata } : { stale: false, text };
}

async function removeIfUnchanged(
  path: string,
  text: string,
  identity: Stats,
  assertFence: () => Promise<void>,
): Promise<boolean> {
  try {
    const [currentText, current] = await Promise.all([Bun.file(path).text(), lstat(path)]);
    if (current.isSymbolicLink() || current.nlink > 1 || currentText !== text || !sameIdentity(identity, current))
      return false;
    await assertFence();
    const [latestText, latest] = await Promise.all([Bun.file(path).text(), lstat(path)]);
    if (latestText !== text || latest.isSymbolicLink() || latest.nlink > 1 || !sameIdentity(identity, latest))
      return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function observeProcessFileLock(path: string): Promise<{ readonly owner: string } | undefined> {
  const inspection = await ownerIsStale(path);
  if (inspection.stale || inspection.text === undefined) return undefined;
  const record = parseRecord(inspection.text);
  return record === undefined ? undefined : { owner: record.owner };
}

export async function acquireProcessFileLock(path: string, signal?: AbortSignal): Promise<ProcessFileLock> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafePath(path);
  const owner = randomUUID();
  const starttime = (await processStarttime(process.pid)) ?? STARTTIME_UNAVAILABLE;
  const content = JSON.stringify({ pid: process.pid, owner, createdAt: Date.now(), starttime } satisfies LockRecord);
  const deadline = Date.now() + WAIT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: Stats | undefined;
  let predecessor: string | undefined;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const acquired = await runWithRecoveryFence(
      {
        lockPath: path,
        staleMs: STALE_MS,
        heartbeatMs: HEARTBEAT_MS,
        deadline,
        timeoutError: () => new Error(`Timed out waiting for process lock: ${path}`),
        ...(signal === undefined ? {} : { signal }),
      },
      async (assertFence) => {
        try {
          await assertSafePath(path);
          handle = await open(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          await handle.writeFile(content);
          await handle.sync();
          identity = await handle.stat();
          await assertFence();
          clearAbandonedOwner(path);
          return true;
        } catch (error) {
          if (isNodeError(error, 'EEXIST')) {
            if (await reclaimAbandonedOwner(path, assertFence)) return null;
            const inspection = await ownerIsStale(path);
            // Keep the first live owner waited on. Later holders may only be replaying that burst.
            if (predecessor === undefined && !inspection.stale && inspection.text !== undefined) {
              const record = parseRecord(inspection.text);
              if (record !== undefined) predecessor = record.owner;
            }
            if (inspection.stale && inspection.text !== undefined && inspection.identity !== undefined)
              return (await removeIfUnchanged(path, inspection.text, inspection.identity, assertFence)) ? null : false;
            return false;
          }
          throw error;
        }
      },
    );
    if (acquired === true && handle !== undefined && identity !== undefined) break;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for process lock: ${path}`);
    await abortableDelay(50 + Math.floor(Math.random() * 25), signal);
  }
  if (handle === undefined || identity === undefined) throw new Error(`Timed out waiting for process lock: ${path}`);

  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    void handle?.utimes(new Date(), new Date()).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  let released = false;
  const verify = async () => {
    if (released) throw new Error('Process lock ownership lost');
    try {
      const [text, current] = await Promise.all([Bun.file(path).text(), lstat(path)]);
      if (text !== content || current.isSymbolicLink() || current.nlink > 1 || !sameIdentity(identity!, current))
        throw new Error('Process lock ownership lost');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new Error('Process lock ownership lost');
      throw error;
    }
  };
  const assertOwned = async () => {
    await verify();
    await handle!.utimes(new Date(), new Date());
  };
  return {
    owner,
    ...(predecessor === undefined ? {} : { predecessor }),
    async withOwnership(action) {
      await assertOwned();
      const result = await action(assertOwned);
      await assertOwned();
      return result;
    },
    withOwnershipFence: (action) =>
      runWithRecoveryFence(
        {
          lockPath: path,
          staleMs: STALE_MS,
          heartbeatMs: HEARTBEAT_MS,
          deadline: Date.now() + WAIT_MS,
          timeoutError: () => new Error(`Timed out waiting for process lock: ${path}`),
          ...(signal === undefined ? {} : { signal }),
        },
        async (assertFence) => {
          const fenced = async () => {
            await assertFence();
            await assertOwned();
          };
          await fenced();
          return action(fenced);
        },
      ),
    async release() {
      if (released) return;
      released = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      try {
        await runWithRecoveryFence(
          {
            lockPath: path,
            staleMs: STALE_MS,
            heartbeatMs: HEARTBEAT_MS,
            deadline: Date.now() + WAIT_MS,
            timeoutError: () => new Error(`Timed out releasing process lock: ${path}`),
          },
          (assertFence) => removeIfUnchanged(path, content, identity!, assertFence),
        );
        clearAbandonedOwner(path);
      } catch (error) {
        rememberAbandonedOwner(path, { owner, identity: identity!, text: content });
        throw error;
      } finally {
        await handle!.close().catch(() => {});
      }
    },
  };
}

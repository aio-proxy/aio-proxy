import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { processIsAlive, processStarttime } from "../../file-lock/process-identity";
import { acquireRecoveryFence } from "../../file-lock/recovery-fence";
import { clearAbandonedLock, reclaimAbandonedLock, rememberAbandonedLock } from "./abandoned-owner";

export const CONFIG_LOCK_WAIT_MS = 15_000;
export const CONFIG_LOCK_STALE_MS = 60_000;
export const CONFIG_LOCK_HEARTBEAT_MS = 10_000;

type LockRecord = {
  readonly pid: number;
  readonly owner: string;
  readonly createdAt: number;
  readonly starttime?: string;
};

export type ConfigLock = {
  readonly owner: string;
  readonly withOwnership: <T>(action: (assertOwnership: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly withOwnershipFence: <T>(action: () => Promise<T>) => Promise<T>;
  readonly release: () => Promise<void>;
};

const RECOVERY_TIMEOUT = Symbol("config-recovery-timeout");

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs;
}

function parseLock(text: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const { pid, owner, createdAt, starttime } = value as Record<string, unknown>;
    return typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      typeof owner === "string" &&
      typeof createdAt === "number" &&
      (starttime === undefined || typeof starttime === "string")
      ? { pid, owner, createdAt, ...(starttime === undefined ? {} : { starttime }) }
      : null;
  } catch {
    return null;
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    return parseLock(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function withRecoveryFence<T>(
  lockPath: string,
  action: (assertFence: () => Promise<void>) => Promise<T>,
  startedAt = Date.now(),
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const remaining = Math.max(0, CONFIG_LOCK_WAIT_MS - (Date.now() - startedAt));
  const timeout = setTimeout(() => controller.abort(RECOVERY_TIMEOUT), remaining);
  try {
    signal?.throwIfAborted();
    const fence = await acquireRecoveryFence({
      lockPath,
      staleMs: CONFIG_LOCK_STALE_MS,
      heartbeatMs: CONFIG_LOCK_HEARTBEAT_MS,
      signal: controller.signal,
    });
    try {
      return await action(fence.assertOwned);
    } finally {
      await fence.close().catch(() => {});
    }
  } catch (error) {
    if (controller.signal.reason === RECOVERY_TIMEOUT) {
      throw new Error(`Timed out waiting for config recovery fence: ${lockPath}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await Bun.sleep(milliseconds);
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = () => done(signal.reason);
    function done(error?: unknown): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function unlinkOwnedLock(
  path: string,
  owner: string,
  identity: Stats,
  assertFence: () => Promise<void>,
): Promise<void> {
  try {
    const [record, metadata] = await Promise.all([readLock(path), stat(path)]);
    if (record?.owner !== owner || metadata.dev !== identity.dev || metadata.ino !== identity.ino) return;
    await assertFence();
    const [currentRecord, currentMetadata] = await Promise.all([readLock(path), stat(path)]);
    if (
      currentRecord?.owner !== owner ||
      currentMetadata.dev !== identity.dev ||
      currentMetadata.ino !== identity.ino
    ) {
      return;
    }
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function reclaimStaleLock(path: string, assertFence: () => Promise<void>): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
  const [record, metadata] = await Promise.all([Promise.resolve(parseLock(text)), stat(path).catch(() => null)]);
  const staleByHeartbeat = metadata === null || Date.now() - metadata.mtimeMs > CONFIG_LOCK_STALE_MS;
  const alive = record !== null && processIsAlive(record.pid);
  const currentStarttime = record === null || !alive ? null : await processStarttime(record.pid);
  const identityVerifiable = alive && record?.starttime !== undefined && currentStarttime !== null;
  const stale =
    record === null
      ? staleByHeartbeat
      : !alive || (identityVerifiable ? currentStarttime !== record.starttime : staleByHeartbeat);
  if (!stale || metadata === null) return false;
  try {
    await assertFence();
    if ((await readFile(path, "utf8")) !== text) return false;
    const currentMetadata = await stat(path);
    if (!sameFileSnapshot(metadata, currentMetadata)) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
}

export async function acquireConfigLock(path: string, signal?: AbortSignal): Promise<ConfigLock> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  const startedAt = Date.now();
  const starttime = await processStarttime(process.pid);
  while (true) {
    signal?.throwIfAborted();
    const acquired = await withRecoveryFence(
      path,
      async (assertFence) => {
        try {
          const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          let identity: Stats | undefined;
          try {
            const text = JSON.stringify({
              pid: process.pid,
              owner,
              createdAt: Date.now(),
              ...(starttime === null ? {} : { starttime }),
            } satisfies LockRecord);
            await handle.writeFile(text);
            await handle.sync();
            identity = await handle.stat();
            await assertFence();
            clearAbandonedLock(path);
            return { handle, identity, text };
          } catch (error) {
            await handle.close().catch(() => {});
            if (identity !== undefined) await unlinkOwnedLock(path, owner, identity, assertFence).catch(() => {});
            throw error;
          }
        } catch (error) {
          if (!isNodeError(error, "EEXIST")) throw error;
          if (await reclaimAbandonedLock(path, assertFence)) return null;
          return (await reclaimStaleLock(path, assertFence)) ? null : false;
        }
      },
      startedAt,
      signal,
    );
    if (acquired === null) continue;
    if (acquired === false) {
      if (Date.now() - startedAt >= CONFIG_LOCK_WAIT_MS) throw new Error(`Timed out waiting for config lock: ${path}`);
      await abortableDelay(50 + Math.floor(Math.random() * 25), signal);
      continue;
    }
    const { handle, identity, text } = acquired;
    let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      const now = new Date();
      void handle.utimes(now, now).catch(() => {});
    }, CONFIG_LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    const verifyOwnership = async () => {
      try {
        const [record, metadata] = await Promise.all([readLock(path), stat(path)]);
        if (record?.owner !== owner || metadata.dev !== identity.dev || metadata.ino !== identity.ino) {
          throw new Error("Config lock ownership lost");
        }
      } catch (error) {
        if (isNodeError(error, "ENOENT")) throw new Error("Config lock ownership lost");
        throw error;
      }
    };
    const assertOwnership = async () => {
      await verifyOwnership();
      const now = new Date();
      await handle.utimes(now, now);
    };
    return {
      owner,
      async withOwnership<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T> {
        await assertOwnership();
        return action(assertOwnership);
      },
      withOwnershipFence: <T>(action: () => Promise<T>) =>
        withRecoveryFence(path, async (assertFence) => {
          await assertFence();
          await verifyOwnership();
          return action();
        }),
      async release() {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        try {
          await withRecoveryFence(path, (assertFence) => unlinkOwnedLock(path, owner, identity, assertFence));
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

import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isPlainObject } from "es-toolkit/predicate";
import { abortableDelay } from "./delay";
import { isNodeError, sameFileSnapshot } from "./fs";
import { processIsAlive, processStarttime } from "./process-identity";

type RecoveryMarker = {
  readonly pid: number;
  readonly owner: string;
  readonly createdAt: number;
  readonly starttime?: string;
};

export type RecoveryFence = {
  readonly assertOwned: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const STARTTIME_UNAVAILABLE = "unavailable";
const abandonedRecoveryMarkers = new Set<string>();
const RECOVERY_TIMEOUT = Symbol("recovery-timeout");

function parseMarker(text: string): RecoveryMarker | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return null;
    const { pid, owner, createdAt, starttime } = value;
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

async function markerActive(path: string, staleMs: number, ownerIsAlive: (pid: number) => boolean): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const [record, metadata] = await Promise.all([Promise.resolve(parseMarker(text)), stat(path).catch(() => null)]);
  if (metadata === null) return false;
  if (record === null) {
    return removeIfUnchanged(path, text, metadata);
  }
  const alive = ownerIsAlive(record.pid);
  const currentStarttime = alive ? await processStarttime(record.pid) : null;
  const identityVerifiable =
    alive && record.starttime !== undefined && record.starttime !== STARTTIME_UNAVAILABLE && currentStarttime !== null;
  const staleByHeartbeat = Date.now() - metadata.mtimeMs > staleMs;
  const stale = !alive || (identityVerifiable ? currentStarttime !== record.starttime : staleByHeartbeat);
  return stale ? removeIfUnchanged(path, text, metadata) : true;
}

async function removeIfUnchanged(path: string, text: string, metadata: Stats): Promise<boolean> {
  try {
    if ((await readFile(path, "utf8")) !== text) return true;
    const currentMetadata = await stat(path);
    if (!sameFileSnapshot(metadata, currentMetadata)) return true;
    await unlink(path);
    return false;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function recoveryActive(
  lockPath: string,
  staleMs: number,
  ownerIsAlive: (pid: number) => boolean,
  excludePath?: string,
): Promise<boolean> {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.recovery.`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  for (const name of names) {
    const path = join(directory, name);
    if (abandonedRecoveryMarkers.has(path)) continue;
    if (path !== excludePath && name.startsWith(prefix) && (await markerActive(path, staleMs, ownerIsAlive)))
      return true;
  }
  return false;
}

async function createRecoveryFence(lockPath: string, heartbeatMs: number): Promise<RecoveryFence & { path: string }> {
  const owner = randomUUID();
  const path = `${lockPath}.recovery.${owner}`;
  const pendingPath = `${lockPath}.recovery-pending.${owner}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: Stats;
  try {
    const starttime = await processStarttime(process.pid);
    const pending = await open(pendingPath, "wx", 0o600);
    try {
      await pending.writeFile(
        JSON.stringify({
          pid: process.pid,
          owner,
          createdAt: Date.now(),
          ...(starttime === null ? {} : { starttime }),
        } satisfies RecoveryMarker),
      );
      await pending.sync();
    } finally {
      await pending.close().catch(() => {});
    }
    await rename(pendingPath, path);
    handle = await open(path, "r+");
    identity = await handle.stat();
  } catch (error) {
    await unlink(pendingPath).catch(() => {});
    await unlink(path).catch(() => {});
    await handle?.close().catch(() => {});
    throw error;
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    const now = new Date();
    void handle.utimes(now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();
  let closed = false;
  const assertOwned = async () => {
    const [record, metadata] = await Promise.all([readFile(path, "utf8").then(parseMarker), stat(path)]);
    if (record?.owner !== owner || metadata.dev !== identity.dev || metadata.ino !== identity.ino) {
      throw new Error("Lock recovery ownership lost");
    }
  };
  return {
    path,
    assertOwned,
    async close() {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      try {
        const [record, metadata] = await Promise.all([readFile(path, "utf8").then(parseMarker), stat(path)]);
        if (record?.owner === owner && metadata.dev === identity.dev && metadata.ino === identity.ino) {
          await unlink(path);
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          abandonedRecoveryMarkers.add(path);
          throw error;
        }
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}

export async function acquireRecoveryFence(input: {
  readonly lockPath: string;
  readonly staleMs: number;
  readonly heartbeatMs: number;
  readonly signal?: AbortSignal;
  readonly ownerIsAlive?: (pid: number) => boolean;
}): Promise<RecoveryFence> {
  const { lockPath, staleMs, heartbeatMs, signal, ownerIsAlive = processIsAlive } = input;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    signal?.throwIfAborted();
    if (await recoveryActive(lockPath, staleMs, ownerIsAlive)) {
      await abortableDelay(25, signal);
      continue;
    }
    signal?.throwIfAborted();
    const recovery = await createRecoveryFence(lockPath, heartbeatMs);
    try {
      if (await recoveryActive(lockPath, staleMs, ownerIsAlive, recovery.path)) {
        await recovery.close().catch(() => {});
        continue;
      }
      signal?.throwIfAborted();
      await recovery.assertOwned();
      return recovery;
    } catch (error) {
      await recovery.close().catch(() => {});
      throw error;
    }
  }
}

export async function runWithRecoveryFence<T>(
  input: {
    readonly lockPath: string;
    readonly staleMs: number;
    readonly heartbeatMs: number;
    readonly deadline: number;
    readonly timeoutError: () => Error;
    readonly signal?: AbortSignal;
    readonly ownerIsAlive?: (pid: number) => boolean;
  },
  action: (assertFence: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(RECOVERY_TIMEOUT), Math.max(0, input.deadline - Date.now()));
  let fence: RecoveryFence;
  try {
    input.signal?.throwIfAborted();
    fence = await acquireRecoveryFence({ ...input, signal: controller.signal });
  } catch (error) {
    if (error === RECOVERY_TIMEOUT) throw input.timeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
  try {
    return await action(fence.assertOwned);
  } finally {
    await fence.close().catch(() => {});
  }
}

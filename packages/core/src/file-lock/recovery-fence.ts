import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isPlainObject } from "es-toolkit/predicate";
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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs;
}

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

async function markerActive(path: string, staleMs: number): Promise<boolean> {
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
    if (Date.now() - metadata.mtimeMs <= staleMs) return true;
    return removeIfUnchanged(path, text, metadata);
  }
  const alive = processIsAlive(record.pid);
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

async function recoveryActive(lockPath: string, staleMs: number, excludePath?: string): Promise<boolean> {
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
    if (path !== excludePath && name.startsWith(prefix) && (await markerActive(path, staleMs))) return true;
  }
  return false;
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

async function createRecoveryFence(lockPath: string, heartbeatMs: number): Promise<RecoveryFence & { path: string }> {
  const owner = randomUUID();
  const path = `${lockPath}.recovery.${owner}`;
  const handle = await open(path, "wx", 0o600);
  let identity: Stats;
  try {
    const starttime = await processStarttime(process.pid);
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        owner,
        createdAt: Date.now(),
        ...(starttime === null ? {} : { starttime }),
      } satisfies RecoveryMarker),
    );
    await handle.sync();
    identity = await handle.stat();
  } catch (error) {
    await unlink(path).catch(() => {});
    await handle.close().catch(() => {});
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
}): Promise<RecoveryFence> {
  const { lockPath, staleMs, heartbeatMs, signal } = input;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    signal?.throwIfAborted();
    if (await recoveryActive(lockPath, staleMs)) {
      await abortableDelay(25, signal);
      continue;
    }
    signal?.throwIfAborted();
    const recovery = await createRecoveryFence(lockPath, heartbeatMs);
    try {
      if (await recoveryActive(lockPath, staleMs, recovery.path)) {
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

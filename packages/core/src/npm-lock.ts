import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { NpmLockError } from "./error";

const LOCK_FILE = ".aio-proxy-install.lock";
const LOCK_VERSION = 1;
const STALE_LOCK_MS = 5 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 10_000;
const RETRIES = 8;
const STARTTIME_UNAVAILABLE = "unavailable";
const DEFAULT_WAIT_MS = 5_000;
const PROCESS_STARTTIME_WAIT_MS = 250;
const PROCESS_STARTTIME_CLEANUP_WAIT_MS = 250;
const PROCESS_STARTTIME_TIMEOUT = Symbol("process-starttime-timeout");

const LockSchema = z.object({
  pid: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  owner: z.string().min(1).optional(),
  starttime: z.string().min(1),
  version: z.literal(LOCK_VERSION),
});

type LockFile = z.infer<typeof LockSchema>;
const abandonedRecoveryMarkers = new Set<string>();

function sameFileSnapshot(before: Stats | null, after: Stats): boolean {
  return before !== null && before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs;
}

export type NpmInstallLock = {
  readonly withOwnership: <T>(action: (assertOwnership: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly release: () => Promise<void>;
};

function isNodeCode(error: Error, code: string): boolean {
  return "code" in error && typeof error.code === "string" && error.code === code;
}

function observe<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

async function withinProcessStarttimeDeadline<T>(
  promise: Promise<T>,
  waitMs: number,
): Promise<T | typeof PROCESS_STARTTIME_TIMEOUT> {
  observe(promise);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof PROCESS_STARTTIME_TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(PROCESS_STARTTIME_TIMEOUT), waitMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function drainProcessStdout(stdout: ReadableStream<Uint8Array> | null): {
  readonly result: Promise<string>;
  readonly cancel: () => Promise<void>;
} {
  if (stdout === null) return { result: Promise.resolve(""), cancel: async () => {} };
  const reader = stdout.getReader();
  const result = observe(
    (async () => {
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) return text + decoder.decode();
          text += decoder.decode(part.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    })(),
  );
  return {
    result,
    cancel: () => observe(Promise.resolve().then(() => reader.cancel())),
  };
}

async function processStarttime(pid: number): Promise<string | null> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
  const stdout = drainProcessStdout(child.stdout);
  const inspection = observe(Promise.all([stdout.result, child.exited]));
  const result = await withinProcessStarttimeDeadline(inspection, PROCESS_STARTTIME_WAIT_MS);
  if (result !== PROCESS_STARTTIME_TIMEOUT) {
    const [text, code] = result;
    if (code !== 0) return null;
    const trimmed = text.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  try {
    child.kill(9);
  } catch {}
  await Promise.all([
    withinProcessStarttimeDeadline(child.exited, PROCESS_STARTTIME_CLEANUP_WAIT_MS),
    withinProcessStarttimeDeadline(stdout.result, PROCESS_STARTTIME_CLEANUP_WAIT_MS),
    withinProcessStarttimeDeadline(stdout.cancel(), PROCESS_STARTTIME_CLEANUP_WAIT_MS),
  ]);
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    if (isNodeCode(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

function parseLock(text: string): ReturnType<typeof LockSchema.safeParse> {
  try {
    return LockSchema.safeParse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return LockSchema.safeParse(undefined);
    throw error;
  }
}

async function removeIfUnchanged(
  path: string,
  expected: string,
  identity: Stats,
  assertFence: () => Promise<void>,
  matchMtime = false,
): Promise<boolean> {
  try {
    const [text, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (
      text !== expected ||
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino ||
      (matchMtime && metadata.mtimeMs !== identity.mtimeMs)
    ) {
      return false;
    }
    await assertFence();
    const [currentText, currentMetadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (
      currentText !== expected ||
      currentMetadata.dev !== identity.dev ||
      currentMetadata.ino !== identity.ino ||
      (matchMtime && currentMetadata.mtimeMs !== identity.mtimeMs)
    ) {
      return false;
    }
    await rm(path);
    return true;
  } catch (error) {
    if (error instanceof Error && isNodeCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function recoveryMarkerActive(path: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && isNodeCode(error, "ENOENT")) return false;
    throw error;
  }
  const [parsed, metadata] = await Promise.all([Promise.resolve(parseLock(text)), stat(path).catch(() => null)]);
  const lock = parsed.success ? parsed.data : undefined;
  if (metadata === null) return false;
  if (lock === undefined) {
    if (Date.now() - metadata.mtimeMs <= STALE_LOCK_MS) return true;
    try {
      if ((await readFile(path, "utf8")) !== text) return true;
      const currentMetadata = await stat(path);
      if (!sameFileSnapshot(metadata, currentMetadata)) return true;
      await rm(path);
      return false;
    } catch (error) {
      if (error instanceof Error && isNodeCode(error, "ENOENT")) return false;
      throw error;
    }
  }
  const alive = lock !== undefined && processIsAlive(lock.pid);
  const currentStarttime = lock === undefined || !alive ? null : await processStarttime(lock.pid);
  const identityVerifiable =
    alive && lock !== undefined && lock.starttime !== STARTTIME_UNAVAILABLE && currentStarttime !== null;
  const stale = !alive || (identityVerifiable && currentStarttime !== lock.starttime);
  if (!stale) return true;
  try {
    if ((await readFile(path, "utf8")) !== text) return true;
    const currentMetadata = await stat(path);
    if (!sameFileSnapshot(metadata, currentMetadata)) return true;
    await rm(path);
    return false;
  } catch (error) {
    if (error instanceof Error && isNodeCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function recoveryActive(lockPath: string, excludePath?: string): Promise<boolean> {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.recovery.`;
  const names = await readdir(directory).catch((error) => {
    if (error instanceof Error && isNodeCode(error, "ENOENT")) return [];
    throw error;
  });
  for (const name of names) {
    const path = join(directory, name);
    if (abandonedRecoveryMarkers.has(path)) continue;
    if (path !== excludePath && name.startsWith(prefix) && (await recoveryMarkerActive(path))) return true;
  }
  return false;
}

async function createRecoveryMarker(lockPath: string): Promise<{
  readonly path: string;
  readonly assertActive: () => Promise<void>;
  readonly release: () => Promise<void>;
}> {
  const owner = randomUUID();
  const path = `${lockPath}.recovery.${owner}`;
  const handle = await open(path, "wx", 0o600);
  let identity: Stats;
  try {
    const starttime = (await processStarttime(process.pid)) ?? STARTTIME_UNAVAILABLE;
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        owner,
        starttime,
        version: LOCK_VERSION,
      } satisfies LockFile),
    );
    await handle.sync();
    identity = await handle.stat();
  } catch (error) {
    await rm(path, { force: true });
    await handle.close().catch(() => {});
    throw error;
  }
  return {
    path,
    async assertActive() {
      const [current, metadata] = await Promise.all([readFile(path, "utf8").then(parseLock), stat(path)]);
      if (
        !current.success ||
        current.data.owner !== owner ||
        metadata.dev !== identity.dev ||
        metadata.ino !== identity.ino
      ) {
        throw new Error("Npm lock ownership lost");
      }
    },
    async release() {
      try {
        const [current, metadata] = await Promise.all([readFile(path, "utf8").then(parseLock), stat(path)]);
        if (
          current.success &&
          current.data.owner === owner &&
          metadata.dev === identity.dev &&
          metadata.ino === identity.ino
        ) {
          await rm(path);
        }
      } catch (error) {
        if (!(error instanceof Error) || !isNodeCode(error, "ENOENT")) throw error;
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}

async function withRecoveryFence<T>(
  lockPath: string,
  action: (assertFence: () => Promise<void>) => Promise<T>,
  deadline: number,
  timeoutError: () => Error,
): Promise<T> {
  while (true) {
    if (await recoveryActive(lockPath)) {
      if (Date.now() >= deadline) throw timeoutError();
      await Bun.sleep(25);
      continue;
    }
    const recovery = await createRecoveryMarker(lockPath);
    try {
      if (await recoveryActive(lockPath, recovery.path)) {
        if (Date.now() >= deadline) throw timeoutError();
        continue;
      }
      await recovery.assertActive();
      return await action(recovery.assertActive);
    } finally {
      await recovery.release().catch(() => {
        abandonedRecoveryMarkers.add(recovery.path);
      });
    }
  }
}

async function recoverStaleLock(path: string, assertFence: () => Promise<void>): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && isNodeCode(error, "ENOENT")) return true;
    throw error;
  }

  const parsed = parseLock(text);
  const lock = parsed.success ? parsed.data : undefined;
  const metadata = await stat(path).catch(() => null);
  const staleByHeartbeat = metadata === null || Date.now() - metadata.mtimeMs > STALE_LOCK_MS;
  const ownerAlive = lock === undefined ? false : processIsAlive(lock.pid);
  const ownerStarttime = lock === undefined || !ownerAlive ? null : await processStarttime(lock.pid);
  const identityVerifiable =
    ownerAlive && lock !== undefined && lock.starttime !== STARTTIME_UNAVAILABLE && ownerStarttime !== null;
  const staleByOwner = lock === undefined || !ownerAlive || (identityVerifiable && ownerStarttime !== lock.starttime);
  const stale = lock === undefined ? staleByHeartbeat : staleByOwner;
  if (!stale || metadata === null) return false;
  return removeIfUnchanged(path, text, metadata, assertFence, true);
}

function retryDelay(attempt: number): number {
  const base = Math.min(2_000, 100 * 1.35 ** attempt);
  return Math.floor(base * (0.5 + Math.random()));
}

export async function acquireNpmInstallLock(
  pkg: string,
  cacheDir: string,
  options: { readonly waitMs?: number } = {},
): Promise<NpmInstallLock> {
  const lockPath = join(cacheDir, LOCK_FILE);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const timeoutError = () => new NpmLockError(pkg);
  const starttime = (await processStarttime(process.pid)) ?? STARTTIME_UNAVAILABLE;
  const owner = randomUUID();
  const lock: LockFile = {
    pid: process.pid,
    createdAt: Date.now(),
    owner,
    starttime,
    version: LOCK_VERSION,
  };
  const content = JSON.stringify(lock);

  let failedGeneration: string | null = null;
  let attempts = 0;
  while (attempts < RETRIES && Date.now() < deadline) {
    const acquired = await withRecoveryFence(
      lockPath,
      async (assertFence) => {
        try {
          const handle = await open(lockPath, "wx", 0o600);
          let identity: Stats | undefined;
          try {
            await handle.writeFile(content);
            await handle.sync();
            identity = await handle.stat();
            await assertFence();
            return { handle, identity };
          } catch (error) {
            await handle.close().catch(() => {});
            if (identity !== undefined) {
              await removeIfUnchanged(lockPath, content, identity, assertFence).catch(() => {});
            }
            throw error;
          }
        } catch (error) {
          if (!(error instanceof Error) || !isNodeCode(error, "EEXIST")) throw error;
          return (await recoverStaleLock(lockPath, assertFence)) ? null : false;
        }
      },
      deadline,
      timeoutError,
    );
    if (acquired === null) continue;
    if (acquired === false) {
      const generation = await readFile(lockPath, "utf8").catch(() => null);
      if (generation !== failedGeneration) {
        failedGeneration = generation;
        attempts = 0;
      } else {
        attempts += 1;
      }
      if (attempts >= RETRIES || Date.now() >= deadline) break;
      await Bun.sleep(Math.min(retryDelay(attempts), Math.max(0, deadline - Date.now())));
      continue;
    }
    const { handle, identity } = acquired;
    let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      const now = new Date();
      void handle.utimes(now, now).catch(() => {});
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    const verifyOwnership = async () => {
      try {
        const [currentText, currentMetadata] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
        if (currentText !== content || currentMetadata.dev !== identity.dev || currentMetadata.ino !== identity.ino) {
          throw new Error("Npm lock ownership lost");
        }
      } catch (error) {
        if (error instanceof Error && isNodeCode(error, "ENOENT")) throw new Error("Npm lock ownership lost");
        throw error;
      }
    };
    const assertOwnership = async () => {
      await withRecoveryFence(
        lockPath,
        async (assertFence) => {
          await assertFence();
          await verifyOwnership();
          const now = new Date();
          await handle.utimes(now, now);
        },
        Date.now() + waitMs,
        timeoutError,
      );
    };
    return {
      async withOwnership<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T> {
        await assertOwnership();
        const result = await action(assertOwnership);
        await assertOwnership();
        return result;
      },
      async release() {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
        try {
          await withRecoveryFence(
            lockPath,
            (assertFence) => removeIfUnchanged(lockPath, content, identity, assertFence),
            Date.now() + waitMs,
            timeoutError,
          );
        } finally {
          await handle.close().catch(() => {});
        }
      },
    };
  }
  throw new NpmLockError(pkg);
}

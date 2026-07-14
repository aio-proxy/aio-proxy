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
  const stdout = child.stdout;
  const text = stdout === null ? "" : await new Response(stdout).text();
  const code = await child.exited;
  if (code !== 0) {
    return null;
  }
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
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
): Promise<boolean> {
  try {
    const [text, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (text !== expected || metadata.dev !== identity.dev || metadata.ino !== identity.ino) return false;
    await assertFence();
    const [currentText, currentMetadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (currentText !== expected || currentMetadata.dev !== identity.dev || currentMetadata.ino !== identity.ino) {
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
  const staleByHeartbeat = metadata === null || Date.now() - metadata.mtimeMs > STALE_LOCK_MS;
  const alive = lock !== undefined && processIsAlive(lock.pid);
  const currentStarttime = lock === undefined || !alive ? null : await processStarttime(lock.pid);
  const identityVerifiable =
    alive && lock !== undefined && lock.starttime !== STARTTIME_UNAVAILABLE && currentStarttime !== null;
  const stale =
    lock === undefined
      ? staleByHeartbeat
      : !alive || (identityVerifiable && (currentStarttime !== lock.starttime || staleByHeartbeat));
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
  const starttime = (await processStarttime(process.pid)) ?? STARTTIME_UNAVAILABLE;
  try {
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
  } catch (error) {
    await rm(path, { force: true });
    await handle.close().catch(() => {});
    throw error;
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    const now = new Date();
    void handle.utimes(now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    path,
    async assertActive() {
      const current = parseLock(await readFile(path, "utf8"));
      if (!current.success || current.data.owner !== owner || (await recoveryActive(lockPath, path))) {
        throw new Error("Npm lock ownership lost");
      }
      const now = new Date();
      await handle.utimes(now, now);
    },
    async release() {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      try {
        await rm(path, { force: true });
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}

async function withRecoveryFence<T>(
  lockPath: string,
  action: (assertFence: () => Promise<void>) => Promise<T>,
): Promise<T> {
  while (true) {
    if (await recoveryActive(lockPath)) {
      await Bun.sleep(25);
      continue;
    }
    const recovery = await createRecoveryMarker(lockPath);
    try {
      if (await recoveryActive(lockPath, recovery.path)) continue;
      await recovery.assertActive();
      return await action(recovery.assertActive);
    } finally {
      await recovery.release().catch(() => {
        abandonedRecoveryMarkers.add(recovery.path);
      });
    }
  }
}

async function recoverStaleLock(path: string): Promise<boolean> {
  if (await recoveryActive(path)) return false;
  const recovery = await createRecoveryMarker(path);
  try {
    if (await recoveryActive(path, recovery.path)) return false;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && isNodeCode(error, "ENOENT")) {
        return true;
      }
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
    const stale = lock === undefined ? staleByHeartbeat : staleByOwner || (identityVerifiable && staleByHeartbeat);
    if (!stale) return false;
    if (metadata === null) return false;
    return await removeIfUnchanged(path, text, metadata, recovery.assertActive);
  } finally {
    await recovery.release();
  }
}

function retryDelay(attempt: number): number {
  const base = Math.min(2_000, 100 * 1.35 ** attempt);
  return Math.floor(base * (0.5 + Math.random()));
}

export async function acquireNpmInstallLock(pkg: string, cacheDir: string): Promise<NpmInstallLock> {
  const lockPath = join(cacheDir, LOCK_FILE);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
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
  while (attempts < RETRIES) {
    if (await recoveryActive(lockPath)) {
      await Bun.sleep(retryDelay(attempts));
      continue;
    }
    try {
      const handle = await open(lockPath, "wx", 0o600);
      let identity: Stats | undefined;
      try {
        await handle.writeFile(content);
        await handle.sync();
        identity = await handle.stat();
        if (await recoveryActive(lockPath)) {
          await handle.close();
          await withRecoveryFence(lockPath, (assertFence) =>
            removeIfUnchanged(lockPath, content, identity as Stats, assertFence),
          );
          await Bun.sleep(retryDelay(attempts));
          continue;
        }
      } catch (error) {
        await handle.close().catch(() => {});
        if (identity !== undefined) {
          await withRecoveryFence(lockPath, (assertFence) =>
            removeIfUnchanged(lockPath, content, identity as Stats, assertFence),
          ).catch(() => {});
        }
        throw error;
      }
      let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return {
        async withOwnership<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T> {
          return withRecoveryFence(lockPath, async (assertFence) => {
            const assertOwnership = async () => {
              await assertFence();
              const [currentText, currentMetadata] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
              if (
                currentText !== content ||
                currentMetadata.dev !== (identity as Stats).dev ||
                currentMetadata.ino !== (identity as Stats).ino
              ) {
                throw new Error("Npm lock ownership lost");
              }
              const now = new Date();
              await handle.utimes(now, now);
            };
            await assertOwnership();
            const result = await action(assertOwnership);
            await assertOwnership();
            return result;
          });
        },
        async release() {
          try {
            await withRecoveryFence(lockPath, async (assertFence) => {
              if (heartbeat !== undefined) {
                clearInterval(heartbeat);
                heartbeat = undefined;
              }
              await removeIfUnchanged(lockPath, content, identity as Stats, assertFence);
            });
          } finally {
            await handle.close().catch(() => {});
          }
        },
      };
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      if (!isNodeCode(error, "EEXIST")) {
        throw error;
      }
      if (await recoverStaleLock(lockPath)) {
        continue;
      }
      const generation = await readFile(lockPath, "utf8").catch(() => null);
      if (generation !== failedGeneration) {
        failedGeneration = generation;
        attempts = 0;
      } else {
        attempts += 1;
      }
      await Bun.sleep(retryDelay(attempts));
    }
  }
  throw new NpmLockError(pkg);
}

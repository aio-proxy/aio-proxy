import type { Stats } from "node:fs";

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { NpmLockError } from "./error";
import { isNodeError } from "./file-lock/fs";
import { processIsAlive, processStarttime } from "./file-lock/process-identity";
import { runWithRecoveryFence } from "./file-lock/recovery-fence";

const LOCK_FILE = ".aio-proxy-install.lock";
const LOCK_VERSION = 1;
const STALE_LOCK_MS = 5 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 10_000;
const RETRIES = 8;
const STARTTIME_UNAVAILABLE = "unavailable";
const DEFAULT_WAIT_MS = 5_000;

const LockSchema = z.object({
  pid: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  owner: z.string().min(1).optional(),
  starttime: z.string().min(1),
  version: z.literal(LOCK_VERSION),
});

type LockFile = z.infer<typeof LockSchema>;

export type NpmInstallLock = {
  readonly withOwnership: <T>(action: (assertOwnership: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly release: () => Promise<void>;
};

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
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function withRecoveryFence<T>(
  lockPath: string,
  action: (assertFence: () => Promise<void>) => Promise<T>,
  deadline: number,
  timeoutError: () => Error,
): Promise<T> {
  return runWithRecoveryFence(
    {
      lockPath,
      staleMs: STALE_LOCK_MS,
      heartbeatMs: LOCK_HEARTBEAT_MS,
      deadline,
      timeoutError,
    },
    action,
  );
}

async function recoverStaleLock(path: string, assertFence: () => Promise<void>): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
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
  const stale =
    lock === undefined
      ? staleByHeartbeat
      : !ownerAlive || (identityVerifiable ? ownerStarttime !== lock.starttime : staleByHeartbeat);
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
    let acquired: { handle: Awaited<ReturnType<typeof open>>; identity: Stats } | null | false;
    try {
      const handle = await open(lockPath, "wx", 0o600);
      let identity: Stats | undefined;
      try {
        await handle.writeFile(content);
        await handle.sync();
        identity = await handle.stat();
        const currentText = await readFile(lockPath, "utf8");
        if (currentText !== content) {
          await removeIfUnchanged(lockPath, content, identity, async () => {}).catch(() => {});
          await handle.close().catch(() => {});
          acquired = null;
        } else {
          acquired = { handle, identity };
        }
      } catch (error) {
        await handle.close().catch(() => {});
        if (identity !== undefined) {
          await removeIfUnchanged(lockPath, content, identity, async () => {}).catch(() => {});
        }
        throw error;
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      // Only serialize the stale-unlink mutation; live owners must not block on recovery fences.
      const recovered = await withRecoveryFence(
        lockPath,
        (assertFence) => recoverStaleLock(lockPath, assertFence),
        deadline,
        timeoutError,
      );
      acquired = recovered ? null : false;
    }
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
        if (isNodeError(error, "ENOENT")) throw new Error("Npm lock ownership lost");
        throw error;
      }
    };
    const assertOwnership = async () => {
      await verifyOwnership();
      const now = new Date();
      await handle.utimes(now, now);
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
          await removeIfUnchanged(lockPath, content, identity, async () => {});
        } finally {
          await handle.close().catch(() => {});
        }
      },
    };
  }
  throw new NpmLockError(pkg);
}

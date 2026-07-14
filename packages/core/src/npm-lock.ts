import { randomUUID } from "node:crypto";
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

export type NpmInstallLock = {
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

async function removeIfUnchanged(path: string, expected: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === expected) {
      await rm(path);
    }
  } catch (error) {
    if (error instanceof Error && isNodeCode(error, "ENOENT")) {
      return;
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
  const stale =
    lock === undefined
      ? staleByHeartbeat
      : !alive ||
        (currentStarttime !== null && lock.starttime !== STARTTIME_UNAVAILABLE && currentStarttime !== lock.starttime);
  if (!stale) return true;
  await rm(path, { force: true });
  return false;
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
    if (path !== excludePath && name.startsWith(prefix) && (await recoveryMarkerActive(path))) return true;
  }
  return false;
}

async function createRecoveryMarker(
  lockPath: string,
): Promise<{ readonly path: string; readonly release: () => Promise<void> }> {
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
    const staleByOwner =
      lock === undefined ||
      !ownerAlive ||
      (ownerStarttime !== null && lock.starttime !== STARTTIME_UNAVAILABLE && ownerStarttime !== lock.starttime);
    const stale = lock === undefined ? staleByHeartbeat : staleByOwner;
    if (!stale) return false;
    await removeIfUnchanged(path, text);
    return true;
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

  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    if (await recoveryActive(lockPath)) {
      await Bun.sleep(retryDelay(attempt));
      continue;
    }
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
        if (await recoveryActive(lockPath)) {
          await removeIfUnchanged(lockPath, content);
          await handle.close();
          await Bun.sleep(retryDelay(attempt));
          continue;
        }
      } catch (error) {
        await rm(lockPath, { force: true }).catch(() => {});
        await handle.close().catch(() => {});
        throw error;
      }
      let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return {
        async release() {
          if (heartbeat !== undefined) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          try {
            await removeIfUnchanged(lockPath, content);
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
      await Bun.sleep(retryDelay(attempt));
    }
  }
  throw new NpmLockError(pkg);
}

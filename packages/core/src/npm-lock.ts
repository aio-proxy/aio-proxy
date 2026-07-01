import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const LOCK_FILE = ".aio-proxy-install.lock";
const LOCK_VERSION = 1;
const STALE_LOCK_MS = 5 * 60 * 1000;
const RETRIES = 8;
const STARTTIME_UNAVAILABLE = "unavailable";

const LockSchema = z.object({
  pid: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  starttime: z.string().min(1),
  version: z.literal(LOCK_VERSION),
});

type LockFile = z.infer<typeof LockSchema>;

export type NpmInstallLock = {
  readonly release: () => Promise<void>;
};

export class NpmLockError extends Error {
  override readonly name = "NpmLockError";

  constructor(readonly pkg: string) {
    super(`Unable to acquire install lock for ${pkg}`);
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
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
    if (isNodeCode(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

async function removeIfUnchanged(
  path: string,
  expected: string,
): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === expected) {
      await rm(path);
    }
  } catch (error) {
    if (!isNodeCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function recoverStaleLock(path: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }

  let parsed = LockSchema.safeParse(undefined);
  try {
    parsed = LockSchema.safeParse(JSON.parse(text));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const lock = parsed.success ? parsed.data : undefined;
  const staleByAge =
    lock === undefined || Date.now() - lock.createdAt > STALE_LOCK_MS;
  const ownerAlive = lock === undefined ? false : processIsAlive(lock.pid);
  const ownerStarttime =
    lock === undefined || !ownerAlive ? null : await processStarttime(lock.pid);
  const staleByOwner =
    lock === undefined ||
    !ownerAlive ||
    (ownerStarttime !== null &&
      lock.starttime !== STARTTIME_UNAVAILABLE &&
      ownerStarttime !== lock.starttime);

  if (!staleByAge && !staleByOwner) {
    return false;
  }
  await removeIfUnchanged(path, text);
  return true;
}

function retryDelay(attempt: number): number {
  const base = Math.min(2_000, 100 * 1.35 ** attempt);
  return Math.floor(base * (0.5 + Math.random()));
}

export async function acquireNpmInstallLock(
  pkg: string,
  cacheDir: string,
): Promise<NpmInstallLock> {
  const lockPath = join(cacheDir, LOCK_FILE);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const starttime =
    (await processStarttime(process.pid)) ?? STARTTIME_UNAVAILABLE;
  const lock: LockFile = {
    pid: process.pid,
    createdAt: Date.now(),
    starttime,
    version: LOCK_VERSION,
  };
  const content = JSON.stringify(lock);

  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
      return {
        release: () => removeIfUnchanged(lockPath, content),
      };
    } catch (error) {
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

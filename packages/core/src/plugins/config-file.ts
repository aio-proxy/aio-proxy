import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const CONFIG_LOCK_WAIT_MS = 15_000;
export const CONFIG_LOCK_STALE_MS = 60_000;
export const CONFIG_LOCK_HEARTBEAT_MS = 10_000;

type ConfigRecord = Record<string, unknown>;

export type AtomicConfigTransactionOptions = {
  readonly validateCandidate?: (candidate: ConfigRecord) => void;
  readonly verify?: (candidate: ConfigRecord) => Promise<void>;
};

type LockRecord = {
  readonly pid: number;
  readonly owner: string;
  readonly createdAt: number;
  readonly starttime?: string;
};

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameFileSnapshot(before: Stats | null, after: Stats): boolean {
  return before !== null && before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs;
}

function parseConfig(bytes: Uint8Array | null): ConfigRecord {
  if (bytes === null || bytes.byteLength === 0) return {};
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) throw new Error("Config root must be an object");
  return value;
}

function ownerAlive(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

async function processStarttime(pid: number): Promise<string | null> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
  const stdout = child.stdout;
  const text = stdout === null ? "" : await new Response(stdout).text();
  if ((await child.exited) !== 0) return null;
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    return parseLock(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function unlinkOwnedLock(path: string, owner: string): Promise<void> {
  try {
    if ((await readLock(path))?.owner === owner) await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function parseLock(text: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
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

async function recoveryMarkerActive(path: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const [record, metadata] = await Promise.all([Promise.resolve(parseLock(text)), stat(path).catch(() => null)]);
  const staleByHeartbeat = metadata === null || Date.now() - metadata.mtimeMs > CONFIG_LOCK_STALE_MS;
  const alive = record !== null && ownerAlive(record.pid);
  const currentStarttime = record === null || !alive ? null : await processStarttime(record.pid);
  const stale =
    record === null
      ? staleByHeartbeat
      : !alive ||
        (currentStarttime !== null && record.starttime !== undefined && currentStarttime !== record.starttime) ||
        staleByHeartbeat;
  if (!stale) return true;
  try {
    if ((await readFile(path, "utf8")) !== text) return false;
    const currentMetadata = await stat(path);
    if (!sameFileSnapshot(metadata, currentMetadata)) return true;
    await unlink(path);
    return false;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function recoveryActive(lockPath: string, excludePath?: string): Promise<boolean> {
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
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const starttime = await processStarttime(process.pid);
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        owner,
        createdAt: Date.now(),
        ...(starttime === null ? {} : { starttime }),
      } satisfies LockRecord),
    );
    await handle.sync();
  } catch (error) {
    await unlink(path).catch(() => {});
    await handle.close().catch(() => {});
    throw error;
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    const now = new Date();
    void handle.utimes(now, now).catch(() => {});
  }, CONFIG_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    path,
    async assertActive() {
      if ((await readLock(path))?.owner !== owner || (await recoveryActive(lockPath, path))) {
        throw new Error("Config lock ownership lost");
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
        await unlink(path);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}

async function reclaimStaleLock(path: string): Promise<boolean> {
  if (await recoveryActive(path)) return false;
  const recovery = await createRecoveryMarker(path);
  try {
    if (await recoveryActive(path, recovery.path)) return false;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      throw error;
    }
    const [record, metadata] = await Promise.all([Promise.resolve(parseLock(text)), stat(path).catch(() => null)]);
    const stale =
      metadata === null ||
      Date.now() - metadata.mtimeMs > CONFIG_LOCK_STALE_MS ||
      (record !== null && !ownerAlive(record.pid));
    if (!stale) return false;
    try {
      if ((await readFile(path, "utf8")) !== text) return false;
      const currentMetadata = await stat(path);
      if (!sameFileSnapshot(metadata, currentMetadata)) return false;
      await unlink(path);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      throw error;
    }
  } finally {
    await recovery.release();
  }
}

async function acquireLock(path: string): Promise<{
  readonly owner: string;
  readonly withOwnership: <T>(action: (assertOwnership: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly release: () => Promise<void>;
}> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  const starttime = await processStarttime(process.pid);
  const startedAt = Date.now();
  while (true) {
    if (await recoveryActive(path)) {
      if (Date.now() - startedAt >= CONFIG_LOCK_WAIT_MS) throw new Error(`Timed out waiting for config lock: ${path}`);
      await Bun.sleep(50 + Math.floor(Math.random() * 25));
      continue;
    }
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            owner,
            createdAt: Date.now(),
            ...(starttime === null ? {} : { starttime }),
          } satisfies LockRecord),
        );
        await handle.sync();
        if (await recoveryActive(path)) {
          await handle.close();
          await unlinkOwnedLock(path, owner);
          if (Date.now() - startedAt >= CONFIG_LOCK_WAIT_MS) {
            throw new Error(`Timed out waiting for config lock: ${path}`);
          }
          await Bun.sleep(50 + Math.floor(Math.random() * 25));
          continue;
        }
      } catch (error) {
        await handle.close().catch(() => {});
        await unlinkOwnedLock(path, owner).catch(() => {});
        throw error;
      }
      let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => {});
      }, CONFIG_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return {
        owner,
        async withOwnership<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T> {
          while (true) {
            if (await recoveryActive(path)) {
              await Bun.sleep(50 + Math.floor(Math.random() * 25));
              continue;
            }
            const recovery = await createRecoveryMarker(path);
            try {
              if (await recoveryActive(path, recovery.path)) continue;
              const assertOwnership = async () => {
                await recovery.assertActive();
                if ((await readLock(path))?.owner !== owner) throw new Error("Config lock ownership lost");
                const now = new Date();
                await handle.utimes(now, now);
              };
              await assertOwnership();
              return await action(assertOwnership);
            } finally {
              await recovery.release();
            }
          }
        },
        async release() {
          if (heartbeat !== undefined) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          try {
            await unlinkOwnedLock(path, owner);
          } finally {
            await handle.close().catch(() => {});
          }
        },
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (await reclaimStaleLock(path)) continue;
      if (Date.now() - startedAt >= CONFIG_LOCK_WAIT_MS) throw new Error(`Timed out waiting for config lock: ${path}`);
      await Bun.sleep(50 + Math.floor(Math.random() * 25));
    }
  }
}

async function originalFile(path: string): Promise<{ readonly bytes: Uint8Array | null; readonly mode: number }> {
  try {
    const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
    return { bytes, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { bytes: null, mode: 0o600 };
    throw error;
  }
}

async function writeAtomic(
  path: string,
  bytes: Uint8Array,
  mode: number,
  tempPath: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await writeFile(tempPath, bytes, { mode });
  await chmod(tempPath, mode);
  await beforeRename?.();
  await rename(tempPath, path);
}

function encodeCandidate(candidate: ConfigRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(candidate, undefined, 2)}\n`);
}

function stable(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Cannot digest a cyclic provider entry");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => stable(item, seen))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stable(item, seen)]),
      );
  seen.delete(value);
  return result;
}

export class AtomicConfigFile {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<ConfigRecord> {
    return parseConfig((await originalFile(this.#path)).bytes);
  }

  async transaction<T>(
    mutate: (current: ConfigRecord) => Promise<{ readonly next: ConfigRecord; readonly result: T }>,
    options: AtomicConfigTransactionOptions = {},
  ): Promise<T> {
    const lockPath = `${this.#path}.lock`;
    const lock = await acquireLock(lockPath);
    const tempPath = `${this.#path}.${process.pid}.${lock.owner}.tmp`;
    let original: Awaited<ReturnType<typeof originalFile>> | undefined;
    try {
      return await lock.withOwnership(async (assertOwnership) => {
        original = await originalFile(this.#path);
        const current = parseConfig(original.bytes);
        const { next, result } = await mutate(current);
        await assertOwnership();
        if (next === current) return result;
        options.validateCandidate?.(next);
        await writeAtomic(this.#path, encodeCandidate(next), original.mode, tempPath, assertOwnership);
        await assertOwnership();
        try {
          await options.verify?.(next);
        } catch (error) {
          await assertOwnership();
          if (original.bytes === null) {
            try {
              await assertOwnership();
              await unlink(this.#path);
            } catch (rollbackError) {
              if (!isNodeError(rollbackError, "ENOENT")) throw rollbackError;
            }
          } else {
            await writeAtomic(this.#path, original.bytes, original.mode, tempPath, assertOwnership);
          }
          throw error;
        }
        await assertOwnership();
        return result;
      });
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
      await lock.release();
    }
  }

  async replace(
    mutate: (current: ConfigRecord) => ConfigRecord | Promise<ConfigRecord>,
    options: AtomicConfigTransactionOptions = {},
  ): Promise<void> {
    await this.transaction(async (current) => ({ next: await mutate(current), result: undefined }), options);
  }

  async providerEntry(providerId: string): Promise<unknown | undefined> {
    const providers = (await this.read())["providers"];
    return isRecord(providers) ? providers[providerId] : undefined;
  }

  async providerEntryDigest(providerId: string): Promise<string | null> {
    const entry = await this.providerEntry(providerId);
    return entry === undefined
      ? null
      : createHash("sha256")
          .update(JSON.stringify(stable(entry)))
          .digest("hex");
  }
}

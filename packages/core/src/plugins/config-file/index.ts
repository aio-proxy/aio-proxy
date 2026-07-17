import { chmod, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { isPlainObject } from "es-toolkit/predicate";
import { isNodeError } from "../../file-lock/fs";
import { acquireConfigLock } from "./lock";
import { type ConfigRecord, digestProviderEntry, encodeCandidate, parseConfig } from "./serialization";

export { CONFIG_LOCK_HEARTBEAT_MS, CONFIG_LOCK_STALE_MS, CONFIG_LOCK_WAIT_MS } from "./lock";
export { digestProviderEntry } from "./serialization";

export type AtomicConfigTransactionOptions = {
  readonly validateCandidate?: (candidate: ConfigRecord) => void;
  readonly verify?: (candidate: ConfigRecord) => Promise<void>;
  readonly signal?: AbortSignal;
};

export class AtomicConfigCommitUncertainError extends Error {
  override readonly name: string = "AtomicConfigCommitUncertainError";

  constructor() {
    super("Config candidate was committed but its final state could not be confirmed");
  }
}

export class AtomicConfigLockReleaseError extends AtomicConfigCommitUncertainError {
  override readonly name = "AtomicConfigLockReleaseError";

  constructor(cause: unknown) {
    super();
    this.message = `Config transaction completed but lock release failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    this.cause = cause;
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
  commit: (renameCandidate: () => Promise<void>) => Promise<void>,
): Promise<void> {
  await writeFile(tempPath, bytes, { mode });
  await chmod(tempPath, mode);
  await commit(() => rename(tempPath, path));
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
    const lock = await acquireConfigLock(lockPath, options.signal);
    const tempPath = `${this.#path}.${process.pid}.${lock.owner}.tmp`;
    let original: Awaited<ReturnType<typeof originalFile>> | undefined;
    let result: T;
    try {
      result = await lock.withOwnership(async (assertOwnership) => {
        options.signal?.throwIfAborted();
        original = await originalFile(this.#path);
        const current = parseConfig(original.bytes);
        options.signal?.throwIfAborted();
        const { next, result } = await mutate(current);
        options.signal?.throwIfAborted();
        await assertOwnership();
        options.signal?.throwIfAborted();
        if (next === current) return result;
        options.validateCandidate?.(next);
        options.signal?.throwIfAborted();
        await writeAtomic(this.#path, encodeCandidate(next), original.mode, tempPath, lock.withOwnershipFence);
        let candidateCommitted = true;
        try {
          await assertOwnership();
          try {
            await options.verify?.(next);
          } catch (verifyError) {
            try {
              await assertOwnership();
              if (original.bytes === null) {
                try {
                  await lock.withOwnershipFence(() => unlink(this.#path));
                } catch (rollbackError) {
                  if (!isNodeError(rollbackError, "ENOENT")) throw rollbackError;
                }
              } else {
                await writeAtomic(this.#path, original.bytes, original.mode, tempPath, lock.withOwnershipFence);
              }
              await assertOwnership();
              candidateCommitted = false;
            } catch {
              throw new AtomicConfigCommitUncertainError();
            }
            throw verifyError;
          }
          await assertOwnership();
          return result;
        } catch (error) {
          if (candidateCommitted && !(error instanceof AtomicConfigCommitUncertainError)) {
            throw new AtomicConfigCommitUncertainError();
          }
          throw error;
        }
      });
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      await lock.release().catch(() => {});
      throw error;
    }
    await rm(tempPath, { force: true }).catch(() => {});
    try {
      await lock.release();
    } catch (error) {
      throw new AtomicConfigLockReleaseError(error);
    }
    return result;
  }

  async replace(
    mutate: (current: ConfigRecord) => ConfigRecord | Promise<ConfigRecord>,
    options: AtomicConfigTransactionOptions = {},
  ): Promise<void> {
    await this.transaction(async (current) => ({ next: await mutate(current), result: undefined }), options);
  }

  async providerEntry(providerId: string): Promise<unknown | undefined> {
    const providers = (await this.read())["providers"];
    return isPlainObject(providers) ? providers[providerId] : undefined;
  }

  async providerEntryDigest(providerId: string): Promise<string | null> {
    const entry = await this.providerEntry(providerId);
    return entry === undefined ? null : digestProviderEntry(entry);
  }
}

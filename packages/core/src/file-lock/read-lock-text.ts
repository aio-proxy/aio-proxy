import { constants, fstatSync, statSync, unlinkSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

export const MAX_LOCK_RECORD_BYTES = 4_096;
export const DEFAULT_LOCK_READ_MS = 15_000;

export type ReadableLockHandle = {
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

function throwIfLockReadAborted(options: { readonly signal?: AbortSignal }, signal?: AbortSignal): void {
  options.signal?.throwIfAborted();
  if (signal?.aborted) throw new Error('lock record read timed out');
}

export async function withLockReadDeadline<T>(
  options: {
    readonly deadline?: number;
    readonly signal?: AbortSignal;
  },
  operation: () => Promise<T>,
  onAbort?: () => void,
): Promise<T> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.deadline === undefined ? DEFAULT_LOCK_READ_MS : Math.max(0, options.deadline - Date.now());
  if (timeoutMs === 0) throw new Error('lock record read timed out');
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  throwIfLockReadAborted(options, signal);
  let onAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbortListener = () => {
      onAbort?.();
      try {
        throwIfLockReadAborted(options, signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbortListener, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    throwIfLockReadAborted(options, signal);
    throw error;
  } finally {
    if (onAbortListener !== undefined) signal.removeEventListener('abort', onAbortListener);
  }
}

export async function withLockHandleDeadline<T>(
  handle: { close(): Promise<void> },
  options: {
    readonly deadline?: number;
    readonly signal?: AbortSignal;
  },
  operation: () => Promise<T>,
): Promise<T> {
  return withLockReadDeadline(options, operation, () => {
    void handle.close().catch(() => undefined);
  });
}

export function startLockHeartbeat(
  handle: { utimes(atime: Date, mtime: Date): Promise<void>; close(): Promise<void> },
  options: {
    readonly deadline?: number;
    readonly signal?: AbortSignal;
  },
  intervalMs: number,
): { stop(): void } {
  const controller = new AbortController();
  const tickOptions = {
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    signal: AbortSignal.any([controller.signal, ...(options.signal === undefined ? [] : [options.signal])]),
  };
  let busy = false;
  const heartbeat = setInterval(() => {
    if (busy) return;
    busy = true;
    const now = new Date();
    void withLockHandleDeadline(handle, tickOptions, () => handle.utimes(now, now))
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'lock record read timed out') skipClose = true;
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  heartbeat.unref?.();
  return {
    stop() {
      clearInterval(heartbeat);
      controller.abort();
    },
  };
}

export async function readLockRecordText(
  handle: ReadableLockHandle,
  size: number,
  options: {
    readonly maxBytes?: number;
    readonly deadline?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_LOCK_RECORD_BYTES;
  if (!Number.isFinite(size) || size < 0) {
    throw new Error('lock record too large');
  }
  options.signal?.throwIfAborted();
  const timeoutMs = options.deadline === undefined ? DEFAULT_LOCK_READ_MS : Math.max(0, options.deadline - Date.now());
  if (timeoutMs === 0) throw new Error('lock record read timed out');

  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void handle.close().catch(() => undefined);
  };
  const throwIfReadAborted = (): void => {
    options.signal?.throwIfAborted();
    if (cancelled || signal.aborted) throw new Error('lock record read timed out');
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  try {
    if (size === 0) return '';
    const readSize = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    let offset = 0;
    while (offset < readSize) {
      throwIfReadAborted();
      const { bytesRead } = await withLockReadDeadline(
        options,
        () => handle.read(buffer, offset, readSize - offset, offset),
        cancel,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    throwIfReadAborted();
    const text = buffer.subarray(0, offset).toString('utf8');
    if (size > maxBytes && !lockRecordPrefixIsComplete(text)) {
      throw new Error('lock record too large');
    }
    return text;
  } catch (error) {
    throwIfReadAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function lockRecordPrefixIsComplete(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function discardOpenedLock(value: FileHandle, path: string, unlinkOnAbort: boolean): void {
  let identity: ReturnType<typeof fstatSync> | undefined;
  try {
    if (unlinkOnAbort) identity = fstatSync(value.fd);
  } catch {
    void value.close().catch(() => undefined);
    return;
  }
  void value.close().catch(() => undefined);
  if (identity === undefined) return;
  try {
    const current = statSync(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return;
    unlinkSync(path);
  } catch {
    // Replacement or already-removed path must stay.
  }
}

export async function openLockFile(
  path: string,
  flags: number,
  options: {
    readonly deadline?: number;
    readonly signal?: AbortSignal;
  },
  extra?: {
    readonly mode?: number;
    readonly unlinkOnAbort?: boolean;
  },
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  let cancelled = false;
  const discard = (value: FileHandle): void => {
    void discardOpenedLock(value, path, extra?.unlinkOnAbort === true);
  };
  const cancel = (): void => {
    cancelled = true;
    if (handle !== undefined) discard(handle);
  };
  const opened = open(path, flags, extra?.mode).then((value) => {
    handle = value;
    if (cancelled) discard(value);
    return value;
  });
  try {
    await withLockReadDeadline(options, () => opened, cancel);
    if (handle === undefined || cancelled) throw new Error('lock record read timed out');
    return handle;
  } catch (error) {
    cancel();
    throw error;
  }
}

export async function readLockPathText(
  path: string,
  options: {
    readonly maxBytes?: number;
    readonly deadline?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if (handle !== undefined) void handle.close().catch(() => undefined);
  };
  const opened = open(path, flags).then((value) => {
    handle = value;
    if (cancelled) void value.close().catch(() => undefined);
    return value;
  });
  try {
    await withLockReadDeadline(options, () => opened, cancel);
    const file = await withLockReadDeadline(options, () => handle!.stat(), cancel);
    return await readLockRecordText(handle!, file.size, options);
  } finally {
    if (handle !== undefined) void handle.close().catch(() => undefined);
    else void opened.then((value) => value.close()).catch(() => undefined);
  }
}

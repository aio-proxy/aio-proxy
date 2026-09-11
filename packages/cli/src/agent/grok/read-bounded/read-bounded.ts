import type { GrokDeadline } from '../types';

export const MAX_GROK_FILE_BYTES = 1_048_576;
export const DEFAULT_GROK_READ_MS = 3_000;

export type ReadableFileHandle = {
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

export const remainingReadMs = (budget?: GrokDeadline): number =>
  budget === undefined ? DEFAULT_GROK_READ_MS : Math.max(0, budget.deadline - Date.now());

export async function readOpenFileText(
  handle: ReadableFileHandle,
  size: number,
  options: {
    readonly maxBytes: number;
    readonly budget?: GrokDeadline;
    readonly limitError: () => Error;
  },
): Promise<string> {
  if (!Number.isFinite(size) || size < 0 || size > options.maxBytes) throw options.limitError();
  const timeoutMs = remainingReadMs(options.budget);
  if (timeoutMs === 0) throw options.limitError();
  options.budget?.signal.throwIfAborted();

  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.budget === undefined ? [] : [options.budget.signal]),
  ]);
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void handle.close().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  try {
    if (size === 0) return '';
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      if (signal.aborted) throw options.limitError();
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (signal.aborted) throw options.limitError();
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (cancelled || signal.aborted) throw options.limitError();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

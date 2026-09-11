import type { GrokDeadline } from '../types';

export const MAX_GROK_FILE_BYTES = 1_048_576;
export const DEFAULT_GROK_READ_MS = 3_000;

export type ReadableFileHandle = {
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

export const remainingReadMs = (budget?: GrokDeadline): number =>
  budget === undefined ? DEFAULT_GROK_READ_MS : Math.max(0, budget.deadline - Date.now());

export async function withHandleBudget<T>(
  handle: Pick<ReadableFileHandle, 'close'>,
  budget: GrokDeadline | undefined,
  limitError: () => Error,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withReadBudget(budget, limitError, async (signal) => {
    const cancel = (): void => {
      void handle.close().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      return await operation(signal);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  });
}

export async function withReadBudget<T>(
  budget: GrokDeadline | undefined,
  limitError: () => Error,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = remainingReadMs(budget);
  if (timeoutMs === 0) throw limitError();
  budget?.signal.throwIfAborted();
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(budget === undefined ? [] : [budget.signal])]);
  if (signal.aborted) throw limitError();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(limitError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(signal), aborted]);
  } catch (error) {
    if (signal.aborted) throw limitError();
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

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

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | undefined,
  options: {
    readonly maxBytes: number;
    readonly budget?: GrokDeadline;
    readonly limitError: () => Error;
  },
): Promise<string> {
  if (stream === undefined) return '';
  const timeoutMs = remainingReadMs(options.budget);
  if (timeoutMs === 0) throw options.limitError();
  options.budget?.signal.throwIfAborted();
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.budget === undefined ? [] : [options.budget.signal]),
  ]);
  const reader = stream.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw options.limitError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > options.maxBytes) throw options.limitError();
      text += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) throw options.limitError();
    text += decoder.decode();
    return text;
  } catch (error) {
    if (signal.aborted) throw options.limitError();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

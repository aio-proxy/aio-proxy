import { RequestBodyIdleTimeoutError } from './errors';

export async function withAbortAndIdle<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  idleTimeoutMs?: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      if (idleTimeoutMs !== undefined)
        timer = setTimeout(() => reject(new RequestBodyIdleTimeoutError()), idleTimeoutMs);
      abort = () => reject(abortError(signal?.reason));
      signal?.addEventListener('abort', abort, { once: true });
      void task.then(resolve, reject);
      // Already buffered reads may settle immediately even if the caller has
      // aborted. Give the read that chance before cancelling a stalled upload.
      if (signal?.aborted) queueMicrotask(abort);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener('abort', abort);
  }
}

export function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

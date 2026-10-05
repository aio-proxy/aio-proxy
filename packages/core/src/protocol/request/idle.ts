import { RequestBodyIdleTimeoutError } from './errors';

export async function withAbortAndIdle<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw abortError(signal.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new RequestBodyIdleTimeoutError()), idleTimeoutMs);
      abort = () => reject(abortError(signal?.reason));
      signal?.addEventListener('abort', abort, { once: true });
      void task.then(resolve, reject);
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

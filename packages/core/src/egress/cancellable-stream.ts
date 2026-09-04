import type { ModelSseStream } from '../protocol/adapter';

export type EgressRunContext<T> = {
  readonly parts: AsyncIterable<T>;
  readonly enqueue: (value: Uint8Array) => void;
  readonly fail: (error: unknown) => void;
};

export function createCancellableEgressStream<T>(
  source: ReadableStream<T>,
  run: (context: EgressRunContext<T>) => Promise<void>,
): ModelSseStream {
  const reader = source.getReader();
  const completion = Promise.withResolvers<void>();
  void completion.promise.catch(() => {});
  let cancelled = false;
  let canceling: Promise<void> | undefined;
  let writerFinished = false;
  let writerFailure: { readonly error: unknown } | undefined;
  let released = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  let resume: (() => void) | undefined;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  const cancelSource = (reason: unknown): Promise<void> => {
    if (canceling !== undefined) return canceling;
    if (released) return Promise.resolve();
    canceling = reader.cancel(reason).finally(release);
    return canceling;
  };
  // Closing with queued bytes makes later downstream cancellation invisible.
  // Settle only after the queue drains so cancellation can own the outcome.
  const completeIfDrained = () => {
    if (writerFinished && !cancelled && (output.desiredSize ?? 0) > 0) {
      output.close();
      if (writerFailure === undefined) completion.resolve();
      else completion.reject(writerFailure.error);
    }
  };
  const parts = {
    async *[Symbol.asyncIterator]() {
      while (!cancelled) {
        if ((output.desiredSize ?? 0) <= 0) {
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
          resume = undefined;
        }
        if (cancelled) return;
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    },
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      void run({
        parts,
        enqueue: (value) => controller.enqueue(value),
        fail: (error) => {
          writerFailure ??= { error };
          void cancelSource(error).catch(() => {});
        },
      })
        .then(() => {
          if (!cancelled) {
            writerFinished = true;
            completeIfDrained();
          }
        })
        .catch(async (error: unknown) => {
          const alreadyCancelled = cancelled;
          cancelled = true;
          resume?.();
          if (!alreadyCancelled) controller.error(error);
          const cleanup = alreadyCancelled ? canceling : cancelSource(error);
          if (cleanup !== undefined) {
            try {
              await cleanup;
            } catch {}
          }
          if (!alreadyCancelled) completion.reject(error);
        })
        .finally(release);
    },
    pull() {
      resume?.();
      completeIfDrained();
    },
    async cancel(reason) {
      cancelled = true;
      resume?.();
      try {
        await cancelSource(reason);
      } finally {
        completion.reject(writerFailure?.error ?? new DOMException('The operation was aborted.', 'AbortError'));
        release();
      }
    },
  });
  return Object.assign(body, { completion: completion.promise });
}

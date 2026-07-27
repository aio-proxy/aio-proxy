import type { ModelSseStream } from '../protocol/adapter';

export type EgressRunContext<T> = {
  readonly parts: AsyncIterable<T>;
  readonly enqueue: (value: Uint8Array) => void;
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
    canceling ??= reader.cancel(reason).finally(release);
    return canceling;
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
      void run({ parts, enqueue: (value) => controller.enqueue(value) })
        .then(() => {
          if (!cancelled) {
            controller.close();
            completion.resolve();
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
    },
    async cancel(reason) {
      cancelled = true;
      resume?.();
      try {
        await cancelSource(reason);
      } finally {
        completion.reject(reason);
        release();
      }
    },
  });
  return Object.assign(body, { completion: completion.promise });
}

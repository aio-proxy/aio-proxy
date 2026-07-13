export type EgressRunContext<T> = {
  readonly parts: AsyncIterable<T>;
  readonly enqueue: (value: Uint8Array) => void;
};

export function createCancellableEgressStream<T>(
  source: ReadableStream<T>,
  run: (context: EgressRunContext<T>) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let cancelled = false;
  let released = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  let resume: (() => void) | undefined;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
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

  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      void run({ parts, enqueue: (value) => controller.enqueue(value) })
        .then(() => {
          if (!cancelled) controller.close();
        })
        .catch((error: unknown) => {
          if (!cancelled) controller.error(error);
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
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

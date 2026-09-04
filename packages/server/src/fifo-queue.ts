export type FifoQueue = <T>(operation: () => Promise<T>) => Promise<T>;

export type KeyedFifoQueue = <T>(key: string, operation: () => Promise<T>) => Promise<T>;

export function createFifoQueue(): FifoQueue {
  let chain = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const run = chain.then(operation, operation);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** One independent FIFO chain per key; a chain is dropped once nothing is queued behind it. */
export function createKeyedFifoQueue(): KeyedFifoQueue {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

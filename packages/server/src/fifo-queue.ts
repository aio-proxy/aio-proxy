export type FifoQueue = <T>(operation: () => Promise<T>) => Promise<T>;

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

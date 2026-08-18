export function createSingleFlight<TArgs extends readonly unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  let active: Promise<TResult> | undefined;
  return (...args) => {
    active ??= Promise.resolve()
      .then(() => operation(...args))
      .finally(() => {
        active = undefined;
      });
    return active;
  };
}

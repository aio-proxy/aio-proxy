import { AsyncLocalStorage } from 'node:async_hooks';

/** Returned by `tryRun` when another holder has the provider, so the caller can retry later. */
export const PROVIDER_GATE_BUSY: unique symbol = Symbol('PROVIDER_GATE_BUSY');

export interface OAuthProviderGate {
  run<T>(providerId: string, operation: () => Promise<T>): Promise<T>;
  /**
   * Run only if the provider is free right now, never waiting for it. Background work that already
   * holds the configuration FIFO must use this: a login takes this gate first and the FIFO second,
   * so waiting here from inside the FIFO closes a deadlock cycle.
   */
  tryRun<T>(providerId: string, operation: () => Promise<T>): Promise<T | typeof PROVIDER_GATE_BUSY>;
}

export function createOAuthProviderGate(): OAuthProviderGate {
  const active = new AsyncLocalStorage<ReadonlySet<string>>();
  const tails = new Map<string, Promise<void>>();
  async function run<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    if (active.getStore()?.has(providerId)) return operation();
    const previous = tails.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(providerId, current);
    await previous.catch(() => {});
    try {
      return await active.run(new Set([...(active.getStore() ?? []), providerId]), operation);
    } finally {
      release();
      if (tails.get(providerId) === current) tails.delete(providerId);
    }
  }
  return {
    run,
    async tryRun<T>(providerId: string, operation: () => Promise<T>) {
      // A tail exists for exactly as long as someone holds or is queued for the provider, and `run`
      // installs its own before its first await, so this decision cannot be raced from inside a tick.
      if (!active.getStore()?.has(providerId) && tails.has(providerId)) return PROVIDER_GATE_BUSY;
      return run(providerId, operation);
    },
  };
}

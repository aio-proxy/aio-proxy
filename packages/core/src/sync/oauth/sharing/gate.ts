import { AsyncLocalStorage } from 'node:async_hooks';

export interface OAuthProviderGate {
  run<T>(providerId: string, operation: () => Promise<T>): Promise<T>;
}

export function createOAuthProviderGate(): OAuthProviderGate {
  const active = new AsyncLocalStorage<ReadonlySet<string>>();
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(providerId: string, operation: () => Promise<T>) {
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
    },
  };
}

import { redactPluginError } from "@aio-proxy/core";

import type { OAuthQuotaServiceDependencies } from "./context";

import { withOAuthQuotaContext } from "./context";
import { OAuthQuotaResetError, OAuthQuotaResetUnavailableError, OAuthQuotaResetUnsupportedError } from "./errors";
import { readValidatedQuota } from "./read";

export type OAuthQuotaResetter = {
  readonly reset: (providerId: string, signal: AbortSignal) => Promise<void>;
};

function createKeyedSerialExecutor(): <T>(key: string, operation: () => Promise<T>) => Promise<T> {
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

export function createOAuthQuotaResetter(dependencies: OAuthQuotaServiceDependencies): OAuthQuotaResetter {
  const execute = createKeyedSerialExecutor();
  return {
    reset: (providerId, signal) =>
      execute(providerId, () =>
        withOAuthQuotaContext(dependencies, providerId, signal, async (prepared) => {
          const reset = prepared.adapter.quota.reset?.bind(prepared.adapter.quota);
          if (reset === undefined) throw new OAuthQuotaResetUnsupportedError();
          const snapshot = await readValidatedQuota(dependencies, prepared, "plugin.quota.reset.preflight.failed");
          if ((snapshot.resetCredits?.availableCount ?? 0) <= 0) {
            throw new OAuthQuotaResetUnavailableError();
          }
          signal.throwIfAborted();
          try {
            await reset(prepared.accountContext);
          } catch (error) {
            try {
              dependencies.logger({
                event: "plugin.quota.reset.failed",
                code: "QUOTA_RESET_FAILED",
                context: {
                  plugin: prepared.plugin,
                  capability: prepared.capability,
                  providerId: prepared.providerId,
                },
                error: redactPluginError(error, { secretValues: [...prepared.secretValues] }),
              });
            } catch {}
            throw new OAuthQuotaResetError();
          }
        }),
      ),
  };
}

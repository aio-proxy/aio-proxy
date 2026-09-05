import { redactPluginError } from '@aio-proxy/core';

import { createKeyedFifoQueue } from '../fifo-queue';
import type { OAuthQuotaServiceDependencies } from './context';
import { withOAuthQuotaContext } from './context';
import {
  OAuthQuotaResetError,
  OAuthQuotaResetInventoryUnknownError,
  OAuthQuotaResetUnavailableError,
  OAuthQuotaResetUnsupportedError,
} from './errors';
import { readValidatedQuota } from './read';

export type OAuthQuotaResetter = {
  readonly reset: (providerId: string, signal: AbortSignal) => Promise<void>;
};

export function createOAuthQuotaResetter(dependencies: OAuthQuotaServiceDependencies): OAuthQuotaResetter {
  const execute = createKeyedFifoQueue();
  return {
    reset: (providerId, signal) =>
      execute(providerId, () =>
        withOAuthQuotaContext(dependencies, providerId, signal, async (prepared, quota) => {
          const reset = quota.reset?.bind(quota);
          if (reset === undefined) throw new OAuthQuotaResetUnsupportedError();
          const snapshot = await readValidatedQuota(
            dependencies,
            prepared,
            quota,
            'plugin.quota.reset.preflight.failed',
          );
          // A `reset`-capable adapter reports `{ availableCount: 0 }` for an inventory it read as
          // empty; an absent `resetCredits` means it could not read the inventory at all — a timeout,
          // a non-2xx, a malformed body. Both would fail the same emptiness check, so separate them
          // here: only the first is evidence the credit is spent, and the second must stay retryable
          // rather than tell the user their credit is gone on a transient upstream failure.
          if (snapshot.resetCredits === undefined) throw new OAuthQuotaResetInventoryUnknownError();
          if (snapshot.resetCredits.availableCount <= 0) {
            throw new OAuthQuotaResetUnavailableError();
          }
          signal.throwIfAborted();
          try {
            await reset(prepared.accountContext);
          } catch (error) {
            try {
              dependencies.logger({
                event: 'plugin.quota.reset.failed',
                code: 'QUOTA_RESET_FAILED',
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

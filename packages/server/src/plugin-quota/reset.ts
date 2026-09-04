import { redactPluginError } from '@aio-proxy/core';

import { createKeyedFifoQueue } from '../fifo-queue';
import type { OAuthQuotaServiceDependencies } from './context';
import { withOAuthQuotaContext } from './context';
import { OAuthQuotaResetError, OAuthQuotaResetUnavailableError, OAuthQuotaResetUnsupportedError } from './errors';
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
          if ((snapshot.resetCredits?.availableCount ?? 0) <= 0) {
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

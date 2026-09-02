import { redactPluginError, validateOAuthQuotaSnapshot, withAbort } from '@aio-proxy/core';
import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

import { type OAuthQuotaServiceDependencies, type PreparedOAuthQuotaContext, withOAuthQuotaContext } from './context';
import { OAuthQuotaReadError } from './errors';

export type OAuthQuotaReader = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
};

export async function readValidatedQuota(
  dependencies: OAuthQuotaServiceDependencies,
  prepared: PreparedOAuthQuotaContext,
  event: string,
): Promise<OAuthQuotaSnapshot> {
  try {
    // The signal handed to the plugin is advisory: a plugin that never checks it leaves this await
    // pending forever, and `withOAuthQuotaContext`'s `finally { lease.release() }` hangs off that same
    // promise, so a hung read leaks the snapshot lease too. Race it host-side instead.
    const snapshot = await withAbort(prepared.accountContext.signal, () =>
      prepared.adapter.quota.read(prepared.accountContext),
    );
    return validateOAuthQuotaSnapshot(snapshot);
  } catch (error) {
    // Cancellation is the caller's, not the plugin's: surface the abort reason unlogged, the way
    // `signal.throwIfAborted()` would have. The cache turns its own read timeout into a stale entry.
    if (prepared.accountContext.signal.aborted) throw prepared.accountContext.signal.reason;
    try {
      dependencies.logger({
        event,
        code: 'QUOTA_READ_FAILED',
        context: {
          plugin: prepared.plugin,
          capability: prepared.capability,
          providerId: prepared.providerId,
        },
        error: redactPluginError(error, { secretValues: [...prepared.secretValues] }),
      });
    } catch {}
    throw new OAuthQuotaReadError();
  }
}

export function createOAuthQuotaReader(dependencies: OAuthQuotaServiceDependencies): OAuthQuotaReader {
  return {
    read: (providerId, signal) =>
      withOAuthQuotaContext(dependencies, providerId, signal, (prepared) =>
        readValidatedQuota(dependencies, prepared, 'plugin.quota.read.failed'),
      ),
  };
}

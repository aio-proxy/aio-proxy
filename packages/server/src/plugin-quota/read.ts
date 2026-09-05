import { redactPluginError, validateOAuthQuotaSnapshot } from '@aio-proxy/core';
import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { omit } from 'es-toolkit/object';

import {
  type OAuthQuotaCapabilityHandle,
  type OAuthQuotaServiceDependencies,
  type PreparedOAuthQuotaContext,
  withOAuthQuotaContext,
} from './context';
import { OAuthQuotaReadError } from './errors';

export type OAuthQuotaReader = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
};

/**
 * `reset` is optional, so an adapter may report an inventory it cannot spend — a shape that was valid
 * before `reset` existed. Every consumer of `resetCredits` treats a non-zero count as an offer to
 * redeem, and redemption would answer a permanent `OAuthQuotaResetUnsupportedError`. Dropping the
 * inventory here keeps that contract in one place instead of asking each caller to pair the count with
 * a capability probe of its own.
 */
function withRedeemableCredits(snapshot: OAuthQuotaSnapshot, quota: OAuthQuotaCapabilityHandle): OAuthQuotaSnapshot {
  if (quota.reset !== undefined || snapshot.resetCredits === undefined) return snapshot;
  return omit(snapshot, ['resetCredits']);
}

export async function readValidatedQuota(
  dependencies: OAuthQuotaServiceDependencies,
  prepared: PreparedOAuthQuotaContext,
  quota: OAuthQuotaCapabilityHandle,
  event: string,
): Promise<OAuthQuotaSnapshot> {
  try {
    const snapshot = await quota.read(prepared.accountContext);
    return withRedeemableCredits(validateOAuthQuotaSnapshot(snapshot), quota);
  } catch (error) {
    // Cancellation is the caller's, not the plugin's: a cooperative plugin rejects from inside this try
    // when the signal fires, so surface the abort reason unlogged the way `signal.throwIfAborted()`
    // would have. A plugin that ignores the signal never gets here — `withOAuthQuotaContext` races it.
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
      withOAuthQuotaContext(dependencies, providerId, signal, (prepared, quota) =>
        readValidatedQuota(dependencies, prepared, quota, 'plugin.quota.read.failed'),
      ),
  };
}

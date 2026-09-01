import type { PluginRepository } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';
import type { Config } from '@aio-proxy/types';
import { isEqual } from 'es-toolkit/predicate';

import type { OAuthQuotaCache } from '../../plugin-quota';

export type QuotaIdentityTracker = {
  /** Invalidates every Provider whose quota identity differs from the last commit. */
  readonly reconcile: (config: Config) => void;
};

type QuotaIdentityRepository = Pick<PluginRepository, 'readAccount' | 'readPluginSecret'>;

/**
 * Everything in the quota cache is keyed by Provider ID alone, so a cached snapshot is only valid
 * while everything the read depends on is unchanged. That is more than the Provider's own config
 * entry: a reauthentication bumps the account revision, a plugin upgrade or options edit changes the
 * adapter, a rotated plugin secret changes the credentials, and the global proxy changes the route
 * the read takes — all without touching `config.providers[id]`.
 */
function quotaIdentity(config: Config, repository: QuotaIdentityRepository): Map<string, unknown> {
  const identities = new Map<string, unknown>();
  for (const provider of config.providers) {
    if (provider.kind !== ProviderKind.OAuth) continue;
    const account = repository.readAccount(provider.id);
    identities.set(provider.id, {
      provider,
      proxy: config.proxy,
      plugin: config.plugins.find(({ packageName }) => packageName === provider.plugin),
      // Revisions alone: the credential and options themselves must not be held in memory here, and
      // both revisions move whenever either changes.
      account:
        account === null
          ? null
          : {
              plugin: account.plugin,
              capability: account.capability,
              fingerprint: account.fingerprint,
              revision: account.revision,
              runtimeRevision: account.runtimeRevision,
            },
      secret: repository.readPluginSecret(provider.plugin)?.revision ?? null,
    });
  }
  return identities;
}

/**
 * `initial` seeds the baseline from the snapshot that is already live, so the first commit only
 * invalidates what it actually changed rather than every OAuth Provider in the config.
 */
export function createQuotaIdentityTracker(
  cache: OAuthQuotaCache | undefined,
  repository: QuotaIdentityRepository,
  initial: Config,
): QuotaIdentityTracker {
  let previous = quotaIdentity(initial, repository);
  return {
    reconcile: (config) => {
      const next = quotaIdentity(config, repository);
      if (cache === undefined) {
        previous = next;
        return;
      }
      for (const id of new Set([...previous.keys(), ...next.keys()])) {
        // A Provider that stopped being an OAuth Provider — or vanished — is absent from `next`, and
        // its ID is reusable, so its snapshot and "unsupported" mark must go too.
        if (!isEqual(previous.get(id), next.get(id))) cache.invalidate(id);
      }
      previous = next;
    },
  };
}

import { type StoredCatalog, validateModelCatalog } from '@aio-proxy/core';
import type { AccountContext, CredentialPort } from '@aio-proxy/plugin-sdk';
import type { Diagnostic } from '@aio-proxy/types';

import type { PreparedOAuthPluginAccount } from '../plugin-account';
import type { CatalogJobDescriptor, MaterializePluginProviderOptions } from './types';

export function oauthCatalogJob(
  options: MaterializePluginProviderOptions,
  { adapter, account, accountOptions }: PreparedOAuthPluginAccount,
  credentials: CredentialPort<unknown>,
  stored: StoredCatalog | null,
  unavailable: Diagnostic | undefined,
): CatalogJobDescriptor {
  const { config, repository, diagnostics } = options;
  const fence = {
    providerId: config.id,
    plugin: account.plugin,
    capability: account.capability,
    accountRuntimeRevision: account.runtimeRevision,
  };
  return {
    providerId: config.id,
    enabled: config.enabled,
    policy: adapter.catalog.policy,
    stored: stored === null ? null : { refreshedAt: stored.refreshedAt, revision: stored.revision },
    ...(unavailable === undefined ? {} : { unavailableOccurredAt: Date.parse(unavailable.occurredAt) }),
    discover: async (signal) => {
      const startedAt = Date.now();
      const catalog = validateModelCatalog(
        await adapter.catalog.discover({
          credentials: credentials as never,
          options: accountOptions,
          signal,
          ...(options.runtimeFetch === undefined ? {} : { fetch: options.runtimeFetch }),
        } as unknown as AccountContext<unknown, unknown>),
      );
      return () => repository.compareAndSwapCatalog({ ...fence, catalog, startedAt, refreshedAt: Date.now() }).ok;
    },
    markUnavailable: () =>
      repository.writeCatalogUnavailableIfCurrent({
        ...fence,
        diagnostic: diagnostics('CATALOG_UNAVAILABLE', { providerId: config.id, retryable: true }),
      }),
  };
}

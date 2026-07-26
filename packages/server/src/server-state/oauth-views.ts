import type { PluginRepository } from '@aio-proxy/core';
import {
  type DashboardOAuthCapability,
  type DashboardOAuthProviderEdit,
  DashboardOAuthProviderEditSchema,
} from '@aio-proxy/types';

import { dashboardOAuthCapabilities, dashboardOAuthForm } from '../dashboard-routes/oauth-capabilities';
import type { SnapshotManager } from '../plugin-snapshot';
import type { Snapshot } from './snapshot';

export function oauthCapabilities(manager: SnapshotManager): readonly DashboardOAuthCapability[] {
  const lease = manager.acquire();
  try {
    return dashboardOAuthCapabilities((lease.snapshot as Snapshot).plugins.registry);
  } finally {
    lease.release();
  }
}

export function oauthProviderEditView(
  manager: SnapshotManager,
  repository: PluginRepository,
  providerId: string,
): DashboardOAuthProviderEdit | undefined {
  const lease = manager.acquire();
  try {
    const snapshot = lease.snapshot as Snapshot;
    const provider = snapshot.config.providers.find((candidate) => candidate.id === providerId);
    if (provider?.kind !== 'oauth') return undefined;
    const adapter = snapshot.plugins.registry.resolveOAuth(provider.plugin, provider.capability);
    const account = repository.readAccount(providerId);
    const configuredSecrets = new Set(Object.keys(account?.secrets ?? {}));
    const catalog = repository.readCatalog(providerId)?.catalog;
    return DashboardOAuthProviderEditSchema.parse({
      accountLabel: account?.label ?? account?.fingerprint ?? providerId,
      publicValues: provider.options ?? {},
      form: adapter === undefined ? [] : dashboardOAuthForm(adapter.account.options.form, configuredSecrets),
      models: catalog?.language.map(({ id }) => id) ?? [],
    });
  } finally {
    lease.release();
  }
}

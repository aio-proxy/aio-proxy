import type { PluginRepository } from '@aio-proxy/core';
import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import {
  aliasTargetModels,
  AliasConfigSchema,
  type DashboardOAuthCapability,
  type DashboardOAuthProviderEdit,
  DashboardOAuthProviderEditSchema,
  type ProviderAlias,
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

/**
 * The plugin's default aliases, narrowed to what this catalog can actually route. Read-only: it never
 * writes config, so the dashboard is free to merge it into the draft or ignore it.
 *
 * Every failure degrades to "no suggestions" instead of propagating: this runs inside
 * `GET /providers/:id/edit-view`, and one throw here would make the whole editor page unopenable.
 * Hence the try/catch around the entire body rather than the plugin call alone — `defaultAliases` is
 * third-party code, and `catalog` is the product of an unvalidated `JSON.parse` cast, so
 * `catalog.language` is not guaranteed to exist at runtime either.
 */
function pluginAliasSuggestions(
  adapter: OAuthAdapter | undefined,
  catalog: ModelCatalog | undefined,
): ProviderAlias | undefined {
  try {
    if (adapter === undefined || catalog === undefined) return undefined;
    const defaultAliases = adapter.catalog.defaultAliases;
    if (defaultAliases === undefined) return undefined;
    const models = new Set(catalog.language.map(({ id }) => id));
    const applicable: Record<string, ProviderAlias[string]> = {};
    for (const [name, suggestion] of Object.entries(defaultAliases(catalog))) {
      // Per suggestion, never collectively: one malformed or unroutable entry must not cost the
      // user the entries beside it that are perfectly good.
      const parsed = AliasConfigSchema.safeParse(suggestion);
      if (!parsed.success) continue;
      if (aliasTargetModels(parsed.data).some((model) => !models.has(model))) continue;
      applicable[name] = parsed.data;
    }
    // "No suggestions" has exactly one representation, so the dashboard never has to test for both.
    return Object.keys(applicable).length === 0 ? undefined : applicable;
  } catch {
    return undefined;
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
      pluginAliases: pluginAliasSuggestions(adapter, catalog),
    });
  } finally {
    lease.release();
  }
}

import { modelRoutes } from '@aio-proxy/core';
import type { DashboardProviderSummary, Provider } from '@aio-proxy/types';
import { apiProviderEndpoints, ProviderKind, resolveOAuthAlias } from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';

import type { RuntimeProviderInstance } from '../../runtime';

export type ProviderRuntimeSummary = Omit<DashboardProviderSummary, 'state'>;

export function providerSummary(
  provider: RuntimeProviderInstance,
  name?: string,
  config?: Provider,
): ProviderRuntimeSummary {
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.raw !== undefined,
    last_status: 'unknown',
    last_latency: null,
    protocols: [],
    // Only OAuth plugin providers can expose a quota capability.
    hasQuota: false,
    // Same: only OAuth plugin providers can expose a credential refresh capability.
    canRefreshCredential: false,
    // Runtime factories don't carry `name`, so callers pass the config display name through.
    ...(name === undefined ? {} : { name }),
    ...(config === undefined ? {} : providerDisplayFields(config)),
    clientModels: uniq(modelRoutes(provider).map((route) => route.alias)),
    hasApiKey: provider.kind === ProviderKind.Api ? provider.hasApiKey : undefined,
  };
}

export function providerConfigSummary(provider: Provider): ProviderRuntimeSummary {
  const clientModels = uniq(modelRoutes(routableConfig(provider)).map((route) => route.alias));
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.kind === ProviderKind.Api,
    last_status: 'unknown',
    last_latency: null,
    hasQuota: false,
    canRefreshCredential: false,
    name: provider.name,
    ...providerDisplayFields(provider),
    clientModels,
    hasApiKey: provider.kind === ProviderKind.Api ? provider.apiKey !== undefined : undefined,
  };
}

export function providerDiff(
  before: readonly Pick<DashboardProviderSummary, 'id'>[],
  after: readonly Pick<DashboardProviderSummary, 'id'>[],
) {
  const beforeIds = new Set(before.map((provider) => provider.id));
  const afterIds = new Set(after.map((provider) => provider.id));
  return {
    providerIds: {
      added: after.filter((provider) => !beforeIds.has(provider.id)).map((provider) => provider.id),
      removed: before.filter((provider) => !afterIds.has(provider.id)).map((provider) => provider.id),
    },
  };
}

function routableConfig(provider: Provider) {
  if (provider.kind === ProviderKind.OAuth) {
    const alias = resolveOAuthAlias(provider.alias, undefined);
    return {
      id: provider.id,
      enabled: provider.enabled,
      ...(Object.keys(alias).length === 0 ? {} : { alias }),
    };
  }
  return {
    id: provider.id,
    enabled: provider.enabled,
    ...(provider.models === undefined || provider.models.length === 0 ? {} : { models: provider.models }),
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
  };
}

function providerDisplayFields(
  provider: Provider,
): Pick<ProviderRuntimeSummary, 'priority' | 'weight' | 'protocols' | 'packageName'> {
  return {
    ...routingDefaults(provider),
    protocols:
      provider.kind === ProviderKind.Api
        ? uniq(apiProviderEndpoints(provider).map((endpoint) => endpoint.protocol))
        : [],
    ...(provider.kind === ProviderKind.AiSdk ? { packageName: provider.packageName } : {}),
  };
}

export function routingDefaults(provider: { readonly priority?: number; readonly weight?: number }): {
  readonly priority?: number;
  readonly weight?: number;
} {
  return {
    ...(provider.priority === undefined ? {} : { priority: provider.priority }),
    ...(provider.weight === undefined ? {} : { weight: provider.weight }),
  };
}

export function withRoutingDefaults(
  instance: RuntimeProviderInstance,
  provider: Pick<Provider, 'priority' | 'weight'>,
): RuntimeProviderInstance {
  return { ...instance, ...routingDefaults(provider) };
}

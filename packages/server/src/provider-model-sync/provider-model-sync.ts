import type { DiagnosticFactory, ProviderModelCatalogRepository, StoredProviderModels } from '@aio-proxy/core';
import { isRecord } from '@aio-proxy/shared';
import {
  type AiSdkProvider,
  type ApiProvider,
  apiProviderEndpoints,
  type Config,
  type Provider,
  ProviderKind,
  type ProviderState,
} from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';

import type { CatalogJobDescriptor } from '../plugin-runtime';
import { discoverProviderModels } from '../provider-model-discovery';

export const SYNCED_MODELS_TTL_MS = 60 * 60_000;

export function isSyncedProvider(provider: Provider): provider is (ApiProvider | AiSdkProvider) & { syncModels: true } {
  return (provider.kind === ProviderKind.Api || provider.kind === ProviderKind.AiSdk) && provider.syncModels === true;
}

export function modelSourceDigest(provider: ApiProvider | AiSdkProvider): string {
  const source =
    provider.kind === ProviderKind.Api
      ? apiSource(provider)
      : { kind: provider.kind, packageName: provider.packageName, baseURL: provider.options?.['baseURL'] };
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(source)).digest('hex');
}

function apiSource(provider: ApiProvider) {
  const { protocol, baseURL, mode } = apiProviderEndpoints(provider)[0];
  return { kind: provider.kind, protocol, baseURL, mode };
}

/** Stored list for the current source digest minus excludedModels, sorted; undefined when none. */
export function syncedModels(
  provider: ApiProvider | AiSdkProvider,
  stored: StoredProviderModels | null,
): readonly string[] | undefined {
  if (stored === null || stored.sourceDigest !== modelSourceDigest(provider) || stored.models === null)
    return undefined;
  return stored.models.filter((model) => !provider.excludedModels?.includes(model)).toSorted();
}

export type SyncedProviderResolution = {
  readonly providers: readonly Provider[];
  readonly jobs: readonly CatalogJobDescriptor[];
  readonly states: ReadonlyMap<string, ProviderState>;
  readonly lastSuccessAt: ReadonlyMap<string, string>;
};

class SyncedCatalogDiscoveryError extends Error {
  constructor(readonly code: 'catalog_unsupported' | 'catalog_unavailable') {
    super(code);
  }
}

export function resolveSyncedProviders(
  config: Config,
  repository: ProviderModelCatalogRepository,
  diagnostics: DiagnosticFactory,
): SyncedProviderResolution {
  const jobs: CatalogJobDescriptor[] = [];
  const states = new Map<string, ProviderState>();
  const lastSuccessAt = new Map<string, string>();
  const providers = config.providers.map((provider): Provider => {
    if (!isSyncedProvider(provider)) return provider;
    const digest = modelSourceDigest(provider);
    let stored: StoredProviderModels | null = null;
    try {
      const row = repository.read(provider.id);
      if (row?.sourceDigest === digest) stored = row;
    } catch {
      // A corrupt stored catalog must not block config loading or alias routing.
    }
    const models = syncedModels(provider, stored);
    const failure = stored?.failure;
    states.set(
      provider.id,
      models === undefined || failure != null
        ? {
            status: 'ready',
            catalog: 'stale',
            diagnostic: diagnostics(failure?.code ?? 'CATALOG_UNAVAILABLE', {
              providerId: provider.id,
              retryable: failure?.code !== 'CATALOG_UNSUPPORTED',
            }),
          }
        : { status: 'ready', catalog: 'fresh' },
    );
    const refreshed =
      models !== undefined && stored !== null && stored.refreshedAt !== null
        ? { refreshedAt: stored.refreshedAt, revision: 1 }
        : null;
    if (refreshed !== null) lastSuccessAt.set(provider.id, new Date(refreshed.refreshedAt).toISOString());
    jobs.push({
      providerId: provider.id,
      enabled: provider.enabled,
      policy: { kind: 'ttl', ttlMs: SYNCED_MODELS_TTL_MS },
      stored: refreshed,
      ...(failure == null ? {} : { unavailableOccurredAt: failure.at }),
      discover: async (signal) => {
        const result = await discoverProviderModels(config, provider, signal, { strict: true });
        if (!result.ok) throw new SyncedCatalogDiscoveryError(result.code);
        if (result.models.length === 0) throw new SyncedCatalogDiscoveryError('catalog_unavailable');
        return () => {
          repository.writeSuccess(provider.id, digest, uniq(result.models).toSorted(), Date.now());
          return true;
        };
      },
      markUnavailable(error) {
        const code =
          isRecord(error) && error['code'] === 'catalog_unsupported' ? 'CATALOG_UNSUPPORTED' : 'CATALOG_UNAVAILABLE';
        repository.writeFailure(provider.id, digest, code, Date.now());
        return true;
      },
    });
    return { ...provider, models: [...(models ?? [])] };
  });
  return { providers, jobs, states, lastSuccessAt };
}

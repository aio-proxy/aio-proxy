import {
  createEmbeddedBuiltIns,
  createProxyFetch,
  type DiagnosticFactory,
  loadPluginRegistry,
  type PluginLogSink,
  type PluginRegistrySnapshot,
  type PluginRepository,
} from '@aio-proxy/core';
import {
  type Config,
  type DashboardProviderSummary,
  type OAuthProvider,
  ProviderKind,
  type ProviderState,
} from '@aio-proxy/types';
import { compact } from 'es-toolkit/array';

import {
  type CatalogJobDescriptor,
  createRuntimeFetch,
  materializePluginProvider,
  type PluginOptionsIdentityDigest,
  type PluginProviderMaterialization,
  type PluginRuntimeCacheEntry,
  pluginOptionsIdentityDigest,
} from '../plugin-runtime';
import { createProviderRequestTransformFetch } from '../provider-request-transform';
import {
  materializeProviders,
  materializeRuntimeProvider,
  effectiveProxy,
  type ProviderProbe,
  type ProviderRuntime,
  providerSummary,
} from '../provider-runtime';
import { createObservedFetch } from '../request-logging';
import type { ProviderRouteSnapshot, RuntimeProviderInput, RuntimeProviderInstance } from '../runtime';
import { resolveCatalogModalities } from './resolve-catalog-modalities/index';
import { applyMetadataExtend } from './resolve-extend/index';
import type { CreateRouter, ServerStateOptions } from './types';

export type Snapshot = ProviderRouteSnapshot & {
  readonly config: Config;
  readonly plugins: PluginRegistrySnapshot;
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
  readonly catalogJobs: readonly CatalogJobDescriptor[];
  readonly runtimeCache: ReadonlyMap<string, PluginRuntimeCacheEntry>;
  readonly providerStates: ReadonlyMap<string, ProviderState>;
};

function providerStatesFromSummaries(
  summaries: readonly DashboardProviderSummary[],
): ReadonlyMap<string, ProviderState> {
  return new Map(summaries.map((summary) => [summary.id, summary.state] as const));
}

export async function buildSnapshot(
  config: Config,
  previous: Snapshot | undefined,
  options: ServerStateOptions,
  repository: PluginRepository,
  diagnostics: DiagnosticFactory,
  logger: PluginLogSink,
  onDiagnosticChanged: () => void,
  createRouter: CreateRouter,
): Promise<Snapshot> {
  const controlFetch = globalThis.fetch;
  const { plugins, pluginOptionInputs, pluginOptionsDigests } = await loadPlugins(
    config,
    options,
    repository,
    diagnostics,
    logger,
  );
  // Resolve router model `metadata.extend` before model resolution and capability
  // indexing read the policies, so downstream consumers see effective values.
  const configWithExtend = await applyMetadataExtend(config, logger, { onCatalogWarmed: onDiagnosticChanged });
  // models.dev output modalities for ids that only appear in `models`/`alias`, so the
  // capability index can route them (e.g. an image model with no authored metadata).
  const catalogMetadata = await resolveCatalogModalities(configWithExtend, { onCatalogWarmed: onDiagnosticChanged });
  const nonOAuth = {
    ...configWithExtend,
    providers: configWithExtend.providers.filter((provider) => provider.kind !== ProviderKind.OAuth),
  };
  const base = materializeProviders(nonOAuth, { catalogMetadata });
  const oauthConfigs = configWithExtend.providers.filter((provider) => provider.kind === ProviderKind.OAuth);
  const oauth = await Promise.all(
    oauthConfigs.map((provider) => {
      const previousEntry = previous?.runtimeCache.get(provider.id);
      const pluginOptionsDigest = pluginOptionsDigests.get(provider.plugin);
      const pluginOptionInput = pluginOptionInputs.get(provider.plugin);
      if (pluginOptionsDigest === undefined) throw new Error(`Missing plugin options digest for ${provider.plugin}`);
      const resolvedProxy = effectiveProxy(configWithExtend.proxy, provider.proxy);
      const providerFetch = createProxyFetch(resolvedProxy, controlFetch);
      return materializePluginProvider({
        config: provider,
        plugins,
        repository,
        diagnostics,
        logger,
        onDiagnosticChanged,
        pluginOptionsDigest,
        effectiveProxy: resolvedProxy ?? null,
        runtimeFetch: createRuntimeFetch({
          control: providerFetch,
          model: createProviderRequestTransformFetch(provider, createObservedFetch(providerFetch)),
        }),
        ...(pluginOptionInput === undefined || 'error' in pluginOptionInput
          ? {}
          : { pluginSecrets: pluginOptionInput.secret }),
        ...(previousEntry === undefined ? {} : { previous: previousEntry }),
      });
    }),
  );
  const { providers, summaries } = assembleProviders(
    configWithExtend,
    nonOAuth,
    base,
    oauth,
    oauthConfigs,
    diagnostics,
  );
  return {
    config: configWithExtend,
    plugins,
    probes: base.probes,
    providers,
    router: createRouter(providers, configWithExtend.router),
    summaries,
    catalogJobs: compact(oauth.map((item) => item.catalogJob)),
    runtimeCache: new Map(
      compact(
        oauth.map((item) =>
          item.cacheEntry === undefined ? undefined : ([item.summary.id, item.cacheEntry] as const),
        ),
      ),
    ),
    providerStates: providerStatesFromSummaries(summaries),
  };
}

type PluginOptionInput = { public: unknown; secret: unknown } | { public: unknown; error: unknown };
type LoadedPlugins = {
  readonly plugins: PluginRegistrySnapshot;
  readonly pluginOptionInputs: ReadonlyMap<string, PluginOptionInput>;
  readonly pluginOptionsDigests: ReadonlyMap<string, PluginOptionsIdentityDigest>;
};

async function loadPlugins(
  config: Config,
  options: ServerStateOptions,
  repository: PluginRepository,
  diagnostics: DiagnosticFactory,
  logger: PluginLogSink,
): Promise<LoadedPlugins> {
  const builtIns = options.builtIns ?? createEmbeddedBuiltIns();
  const publicPluginOptions = new Map<string, unknown>(builtIns.map((plugin) => [plugin.packageName, undefined]));
  for (const enablement of config.plugins) publicPluginOptions.set(enablement.packageName, enablement.options);
  for (const provider of config.providers) {
    if (provider.kind === ProviderKind.OAuth && !publicPluginOptions.has(provider.plugin)) {
      publicPluginOptions.set(provider.plugin, undefined);
    }
  }
  const pluginOptionInputs = new Map<string, PluginOptionInput>(
    [...publicPluginOptions].map(([packageName, publicOptions]) => {
      try {
        return [
          packageName,
          { public: publicOptions, secret: repository.readPluginSecret(packageName)?.value },
        ] as const;
      } catch (error) {
        return [packageName, { public: publicOptions, error }] as const;
      }
    }),
  );
  const pluginOptionsDigests = new Map(
    [...pluginOptionInputs].map(([packageName, input]) => [
      packageName,
      pluginOptionsIdentityDigest('error' in input ? { public: input.public, secret: undefined } : input),
    ]),
  );
  const plugins = await loadPluginRegistry({
    enablements: config.plugins,
    builtIns,
    diagnostics,
    importPackage: options.importPlugin ?? (async ({ entrypoint }) => import(entrypoint)),
    logger,
    secrets: {
      readPluginSecret(plugin) {
        const input = pluginOptionInputs.get(plugin);
        if (input !== undefined && 'error' in input) throw input.error;
        return input?.secret;
      },
    },
  });
  return { plugins, pluginOptionInputs, pluginOptionsDigests };
}

function assembleProviders(
  config: Config,
  nonOAuth: Config,
  base: ProviderRuntime,
  oauth: readonly PluginProviderMaterialization[],
  oauthConfigs: readonly OAuthProvider[],
  diagnostics: DiagnosticFactory,
): { readonly providers: readonly RuntimeProviderInstance[]; readonly summaries: readonly DashboardProviderSummary[] } {
  const providerById = new Map(
    [...base.providers, ...compact(oauth.map((item) => item.provider))].map(
      (provider) => [provider.id, provider] as const,
    ),
  );
  const providers = compact(config.providers.map((configured) => providerById.get(configured.id)));
  const summaryById = new Map(
    [...base.summaries, ...oauth.map((item) => item.summary)].map((summary) => [summary.id, summary] as const),
  );
  const summaryBases = [
    ...config.invalidProviders.map(
      (invalid) =>
        ({
          id: invalid.id,
          kind: invalid.kind ?? 'invalid',
          enabled: false,
          passthrough: false,
          last_status: 'unknown',
          last_latency: null,
          clientModels: [],
          protocols: [],
          hasQuota: false,
          canRefreshCredential: false,
        }) satisfies Omit<DashboardProviderSummary, 'state'>,
    ),
    ...compact(config.providers.map((configured) => summaryById.get(configured.id))),
  ];
  const assembledStates = new Map<string, ProviderState>();
  for (const provider of nonOAuth.providers) assembledStates.set(provider.id, { status: 'ready' });
  for (const invalid of config.invalidProviders) {
    assembledStates.set(invalid.id, {
      status: 'unavailable',
      diagnostic: diagnostics(invalid.code, { providerId: invalid.id, retryable: false }),
    });
  }
  oauth.forEach((item, index) => {
    const provider = oauthConfigs[index];
    if (provider !== undefined) assembledStates.set(provider.id, item.state);
  });
  const summaries = summaryBases.map((summary): DashboardProviderSummary => {
    const state = assembledStates.get(summary.id);
    if (state === undefined) throw new Error(`Provider state missing for ${summary.id}`);
    return { ...summary, state };
  });
  return { providers, summaries };
}

export function providerConfigRecord(config: Config): Record<string, unknown> {
  return Object.fromEntries([
    ...config.providers.map(({ id, ...provider }) => [id, provider] as const),
    ...config.invalidProviders.map(({ id, kind }) => [id, kind === undefined ? {} : { kind }] as const),
  ]);
}

export function buildSnapshotWithProviders(
  config: Config,
  providers: readonly RuntimeProviderInput[],
  createRouter: CreateRouter,
): Snapshot {
  const materialized = providers.map((provider) => materializeRuntimeProvider(provider));
  const summaries = materialized.map((provider) => ({
    ...providerSummary(provider),
    state: { status: 'ready' } as const,
  }));
  return {
    config,
    plugins: emptyPluginSnapshot(),
    probes: new Map(),
    providers: materialized,
    router: createRouter(materialized, config.router),
    summaries,
    catalogJobs: [],
    runtimeCache: new Map(),
    providerStates: providerStatesFromSummaries(summaries),
  };
}

export function emptyPluginSnapshot(): PluginRegistrySnapshot {
  return { registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] }, plugins: new Map() };
}

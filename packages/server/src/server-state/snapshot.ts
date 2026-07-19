import {
  createEmbeddedBuiltIns,
  type DiagnosticFactory,
  loadPluginRegistry,
  type PluginLogSink,
  type PluginRegistrySnapshot,
  type PluginRepository,
  type Router,
} from "@aio-proxy/core";
import { type Config, type DashboardProviderSummary, ProviderKind, type ProviderState } from "@aio-proxy/types";
import { compact } from "es-toolkit/array";

import type { ProviderRouteSnapshot, RuntimeProviderInput, RuntimeProviderInstance } from "../runtime";
import type { ServerStateOptions } from "./types";

import {
  type CatalogJobDescriptor,
  materializePluginProvider,
  type PluginRuntimeCacheEntry,
  pluginOptionsIdentityDigest,
} from "../plugin-runtime";
import {
  materializeProviders,
  materializeRuntimeProvider,
  type ProviderProbe,
  providerSummary,
} from "../provider-runtime";

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
  createRouter: (providers: readonly RuntimeProviderInstance[]) => Router<RuntimeProviderInstance>,
): Promise<Snapshot> {
  const builtIns = options.builtIns ?? createEmbeddedBuiltIns();
  const publicPluginOptions = new Map<string, unknown>(builtIns.map((plugin) => [plugin.packageName, undefined]));
  for (const enablement of config.plugins) publicPluginOptions.set(enablement.packageName, enablement.options);
  for (const provider of config.providers) {
    if (provider.kind === ProviderKind.OAuth && !publicPluginOptions.has(provider.plugin)) {
      publicPluginOptions.set(provider.plugin, undefined);
    }
  }
  const pluginOptionInputs = new Map<
    string,
    { public: unknown; secret: unknown } | { public: unknown; error: unknown }
  >(
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
      pluginOptionsIdentityDigest("error" in input ? { public: input.public, secret: undefined } : input),
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
        if (input !== undefined && "error" in input) throw input.error;
        return input?.secret;
      },
    },
  });
  const nonOAuth = {
    ...config,
    providers: config.providers.filter((provider) => provider.kind !== ProviderKind.OAuth),
  };
  const base = materializeProviders(nonOAuth);
  const oauthConfigs = config.providers.filter((provider) => provider.kind === ProviderKind.OAuth);
  const oauth = await Promise.all(
    oauthConfigs.map((provider) => {
      const previousEntry = previous?.runtimeCache.get(provider.id);
      const pluginOptionsDigest = pluginOptionsDigests.get(provider.plugin);
      const pluginOptionInput = pluginOptionInputs.get(provider.plugin);
      if (pluginOptionsDigest === undefined) throw new Error(`Missing plugin options digest for ${provider.plugin}`);
      return materializePluginProvider({
        config: provider,
        plugins,
        repository,
        diagnostics,
        logger,
        onDiagnosticChanged,
        pluginOptionsDigest,
        ...(pluginOptionInput === undefined || "error" in pluginOptionInput
          ? {}
          : { pluginSecrets: pluginOptionInput.secret }),
        ...(previousEntry === undefined ? {} : { previous: previousEntry }),
      });
    }),
  );
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
          kind: invalid.kind ?? "invalid",
          enabled: false,
          passthrough: false,
          last_status: "unknown",
          last_latency: null,
          clientModels: [],
        }) satisfies Omit<DashboardProviderSummary, "state">,
    ),
    ...compact(config.providers.map((configured) => summaryById.get(configured.id))),
  ];
  const assembledStates = new Map<string, ProviderState>();
  for (const provider of nonOAuth.providers) assembledStates.set(provider.id, { status: "ready" });
  for (const invalid of config.invalidProviders) {
    assembledStates.set(invalid.id, {
      status: "unavailable",
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
  return {
    config,
    plugins,
    probes: base.probes,
    providers,
    router: createRouter(providers),
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

export function providerConfigRecord(config: Config): Record<string, unknown> {
  return Object.fromEntries([
    ...config.providers.map(({ id, ...provider }) => [id, provider] as const),
    ...config.invalidProviders.map(({ id, kind }) => [id, kind === undefined ? {} : { kind }] as const),
  ]);
}

export function buildSnapshotWithProviders(
  config: Config,
  providers: readonly RuntimeProviderInput[],
  createRouter: (providers: readonly RuntimeProviderInstance[]) => Router<RuntimeProviderInstance>,
): Snapshot {
  const materialized = providers.map((provider) => materializeRuntimeProvider(provider));
  const summaries = materialized.map((provider) => ({
    ...providerSummary(provider),
    state: { status: "ready" } as const,
  }));
  return {
    config,
    plugins: emptyPluginSnapshot(),
    probes: new Map(),
    providers: materialized,
    router: createRouter(materialized),
    summaries,
    catalogJobs: [],
    runtimeCache: new Map(),
    providerStates: providerStatesFromSummaries(summaries),
  };
}

export function emptyPluginSnapshot(): PluginRegistrySnapshot {
  return { registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] }, plugins: new Map() };
}

import { dirname } from "node:path";
import {
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  type BuiltInPluginDefinition,
  createEmbeddedBuiltIns,
  createModelsDevCatalog,
  createPluginDiagnosticFactory,
  createPluginRepository,
  type DiagnosticFactory,
  type FetchModelsDevProviders,
  loadPluginRegistry,
  type ModelsDevCatalog,
  type PendingAccountOperation,
  type PluginLogSink,
  type PluginPackageImporter,
  type PluginRegistrySnapshot,
  type PluginRepository,
  RECOVERY_DRAIN_RETRY_MS,
  Router,
  recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { createRequestLogStore, type OpenDbHandle, openDb, type RequestLogStore } from "@aio-proxy/core/db";
import {
  type Config,
  ConfigSchema,
  type DashboardEvent,
  type DashboardPluginSummary,
  type DashboardProviderProbe,
  type DashboardProviderSummary,
  ProviderKind,
  type ProviderState,
} from "@aio-proxy/types";
import { ZodError } from "zod";
import { asProviderRecord, createAccountRemovalCoordinator } from "./account-removal";
import { CatalogScheduler } from "./catalog-scheduler";
import { type ConfigStore, createConfigStore } from "./config-store";
import { watchConfigFile } from "./config-watcher";
import { createDashboardEventHub, type DashboardEventHub, type DashboardEventLimits } from "./dashboard-events";
import { createFifoQueue } from "./fifo-queue";
import {
  type CatalogJobDescriptor,
  materializePluginProvider,
  type PluginRuntimeCacheEntry,
  pluginOptionsIdentityDigest,
} from "./plugin-runtime";
import { createSnapshotManager } from "./plugin-snapshot";
import {
  materializeProviders,
  materializeRuntimeProvider,
  type ProviderProbe,
  providerDiff,
  providerSummary,
} from "./provider-runtime";
import { createRequestRecorder } from "./request-recorder";
import type {
  ProviderRouteSnapshot,
  ProviderRouteSource,
  RetiredProviderSnapshot,
  RuntimeProviderInput,
  RuntimeProviderInstance,
} from "./runtime";
import { createUsageCapture } from "./usage-capture";

export type ServerStateOptions = {
  readonly config: Config;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly logger?: (entry: ConfigReloadLog) => void;
  readonly modelsDevCatalogTask?: () => Promise<ModelsDevCatalog | undefined>;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly watchConfig?: boolean;
  readonly pluginRepository?: PluginRepository;
  readonly importPlugin?: PluginPackageImporter;
  readonly pluginLogger?: PluginLogSink;
  readonly builtIns?: readonly BuiltInPluginDefinition[];
};

type ServerStateTestHooks = {
  readonly configFile?: AtomicConfigFile;
  readonly createRouter?: (providers: readonly RuntimeProviderInstance[]) => Router<RuntimeProviderInstance>;
  readonly onCatalogJobsReplaced?: (jobs: readonly CatalogJobDescriptor[]) => void;
  readonly reconciliationRetryMs?: number;
  readonly recoveryScheduler?: RecoveryScheduler;
  readonly recoverPendingAccountOperations?: typeof recoverPendingAccountOperations;
};

type RecoveryTimer = { readonly clear: () => void };
type RecoveryScheduler = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => RecoveryTimer;
};

type InternalServerStateOptions = ServerStateOptions & { readonly __test?: ServerStateTestHooks };

const createRuntimeRouter = (providers: readonly RuntimeProviderInstance[]): Router<RuntimeProviderInstance> =>
  new Router(providers);

export type ConfigReloadLog = {
  readonly error: string;
  readonly event: "config.reload_failed";
  readonly stage: "parse" | "providers" | "router" | "alias-collision";
};

export type ConfigReloadResult = { readonly ok: true; readonly diff: ConfigChangedData } | ReloadFailure;

export type ServerState = ProviderRouteSource & {
  readonly close: () => void;
  readonly configPath: string | undefined;
  readonly configStore: ConfigStore;
  readonly events: DashboardEventHub;
  readonly modelsDevCatalog: () => Promise<ModelsDevCatalog | undefined>;
  readonly pluginSummaries: () => readonly DashboardPluginSummary[];
  readonly providerSummaries: (options: ProviderSummaryOptions) => Promise<readonly DashboardProviderSummary[]>;
  readonly reload: () => Promise<ConfigReloadResult>;
  readonly currentConfig: () => Config;
  readonly requestLog: RequestLogStore;
};

export type ProviderSummaryOptions = {
  readonly filter?: string | undefined;
  readonly probe: boolean;
};

type ConfigChangedData = Extract<DashboardEvent, { readonly event: "config.changed" }>["data"];
type ReloadFailure = { readonly error: string; readonly ok: false; readonly stage: ConfigReloadLog["stage"] };

type Snapshot = ProviderRouteSnapshot & {
  readonly config: Config;
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
  readonly catalogJobs: readonly CatalogJobDescriptor[];
  readonly runtimeCache: ReadonlyMap<string, PluginRuntimeCacheEntry>;
  readonly providerStates: ReadonlyMap<string, ProviderState>;
};

type ProviderStatus = { readonly last_latency: number | null; readonly last_status: string };

function providerStatesFromSummaries(
  summaries: readonly DashboardProviderSummary[],
): ReadonlyMap<string, ProviderState> {
  return new Map(summaries.map((summary) => [summary.id, summary.state] as const));
}

const defaultLogger = (entry: ConfigReloadLog): void => console.error(JSON.stringify(entry));
const defaultPluginLogger: PluginLogSink = (entry) => console.error(JSON.stringify(entry));
const PRICE_CATALOG_TTL_MS = 6 * 60 * 60 * 1_000;

export function createServerDiagnosticFactory(now: () => number = Date.now): DiagnosticFactory {
  return createPluginDiagnosticFactory(now);
}

export async function createServerState(options: ServerStateOptions): Promise<ServerState> {
  const testHooks = (options as InternalServerStateOptions).__test;
  const createRouter = testHooks?.createRouter ?? createRuntimeRouter;
  const statuses = new Map<string, ProviderStatus>();
  const events = createDashboardEventHub(options.eventLimits);
  const dbHandle = openServerDb(options);
  const repository = options.pluginRepository ?? createPluginRepository(dbHandle.sqlite);
  const diagnostics = createServerDiagnosticFactory();
  const pluginLogger = options.pluginLogger ?? defaultPluginLogger;
  const configFile =
    testHooks?.configFile ?? (options.configPath === undefined ? undefined : new AtomicConfigFile(options.configPath));
  const recoverAccounts = testHooks?.recoverPendingAccountOperations ?? recoverPendingAccountOperations;
  const reconciliationRetryMs = testHooks?.reconciliationRetryMs ?? RECOVERY_DRAIN_RETRY_MS;
  const recoveryScheduler: RecoveryScheduler = testHooks?.recoveryScheduler ?? {
    now: Date.now,
    setTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return { clear: () => clearTimeout(timer) };
    },
  };
  let recoveryTimer: RecoveryTimer | undefined;
  let recoveryRunAt: number | undefined;
  const reconciliationTimers = new Set<ReturnType<typeof setTimeout>>();
  let recoveryGeneration = 0;
  let closed = false;
  const queue = createFifoQueue();
  let manager: ReturnType<typeof createSnapshotManager>;
  let managerReady = false;

  if (configFile !== undefined) {
    await recoverAccounts(
      configFile,
      repository,
      { mode: "server", canDeleteAccount: () => true, now: recoveryScheduler.now },
      {
        factory: diagnostics,
        logger: pluginLogger,
      },
    );
  }

  let startupDiagnosticRebuildPending = false;
  const queueRebuild = () => {
    if (!managerReady) {
      startupDiagnosticRebuildPending = true;
      return;
    }
    void queue(() => commitConfig((manager.current() as Snapshot).config, "credential-diagnostic")).catch(() => {});
  };
  const initial =
    options.providerInstances === undefined
      ? await buildSnapshot(
          options.config,
          undefined,
          options,
          repository,
          diagnostics,
          pluginLogger,
          queueRebuild,
          createRouter,
        )
      : buildSnapshotWithProviders(options.config, options.providerInstances, createRouter);
  manager = createSnapshotManager(initial);
  managerReady = true;
  const accountRemovals = createAccountRemovalCoordinator({
    file: configFile,
    repository,
    enqueue: queue,
    canDeleteAccount: manager.canDeleteAccount,
    onRecoveryNeeded: scheduleRecovery,
  });
  const scheduler = new CatalogScheduler({
    repository,
    diagnostics,
    rebuild: () => queue(() => commitConfig((manager.current() as Snapshot).config, "catalog")),
  });
  const replaceCatalogJobs = (jobs: readonly CatalogJobDescriptor[]): void => {
    scheduler.replaceJobs(jobs);
    testHooks?.onCatalogJobsReplaced?.(jobs);
  };
  if (startupDiagnosticRebuildPending) {
    startupDiagnosticRebuildPending = false;
    await queue(() => commitConfig((manager.current() as Snapshot).config, "credential-diagnostic"));
  } else {
    replaceCatalogJobs(initial.catalogJobs);
  }

  const requestLog = createRequestLogStore(dbHandle.db);
  const modelsDevCatalog = options.modelsDevCatalogTask ?? createModelsDevCatalogTask();
  const usageCapture = createUsageCapture({ priceCatalogTask: modelsDevCatalog });
  const requestRecorder = createRequestRecorder({ store: requestLog });
  const logger = options.logger ?? defaultLogger;
  async function commitConfig(config: Config, _reason: string): Promise<RetiredProviderSnapshot> {
    const previous = manager.current() as Snapshot;
    const candidate = await buildSnapshot(
      config,
      previous,
      options,
      repository,
      diagnostics,
      pluginLogger,
      queueRebuild,
      createRouter,
    );
    const before = (manager.current() as Snapshot).summaries;
    const retired = manager.swap(candidate);
    accountRemovals.cancelReadded(providerConfigRecord(previous.config), providerConfigRecord(config));
    replaceCatalogJobs(candidate.catalogJobs);
    events.publish({ event: "config.changed", data: providerDiff(before, candidate.summaries) });
    return retired;
  }

  async function reloadNow(retainedOperations: readonly PendingAccountOperation[] = []): Promise<ConfigReloadResult> {
    try {
      const before = (manager.current() as Snapshot).summaries;
      if (configFile === undefined) {
        await commitConfig((manager.current() as Snapshot).config, "reload");
      } else {
        const staged: PendingAccountOperation[] = [...retainedOperations];
        const newlyStaged: PendingAccountOperation[] = [];
        const retainedProviderIds = new Set(retainedOperations.map((operation) => operation.providerId));
        let retired: RetiredProviderSnapshot | undefined;
        try {
          await configFile.transaction(async (current) => {
            const previous = manager.current() as Snapshot;
            const previousProviders = Object.fromEntries(
              Object.entries(providerConfigRecord(previous.config)).filter(
                ([providerId]) => !retainedProviderIds.has(providerId),
              ),
            );
            const detected = accountRemovals.stageRemoved(previousProviders, asProviderRecord(current["providers"]));
            newlyStaged.push(...detected);
            staged.push(...detected);
            retired = await commitConfig(ConfigSchema.parse(current), "reload");
            return { next: current, result: undefined };
          });
        } catch (error) {
          if (retired !== undefined) {
            void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
          } else if (error instanceof AtomicConfigCommitUncertainError) {
            accountRemovals.scheduleRecovery(staged);
          } else {
            accountRemovals.compensate(newlyStaged);
          }
          throw error;
        }
        void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
      }
      return { ok: true, diff: providerDiff(before, (manager.current() as Snapshot).summaries) };
    } catch (error) {
      const result = reloadError(error);
      logger({ error: result.error, event: "config.reload_failed", stage: result.stage });
      return result;
    }
  }

  async function reload(): Promise<ConfigReloadResult> {
    return queue(() => reloadNow());
  }

  function queueReconciliation(operations: readonly PendingAccountOperation[], generation = recoveryGeneration): void {
    if (closed || generation !== recoveryGeneration) return;
    void queue(async () => {
      if (closed || generation !== recoveryGeneration) return;
      try {
        const result = await reloadNow(operations);
        if (!result.ok) scheduleReconciliationRetry(operations, generation);
      } catch {
        scheduleReconciliationRetry(operations, generation);
      }
    }).catch(() => scheduleReconciliationRetry(operations, generation));
  }

  function scheduleReconciliationRetry(operations: readonly PendingAccountOperation[], generation: number): void {
    if (closed || generation !== recoveryGeneration) return;
    const timer = setTimeout(() => {
      reconciliationTimers.delete(timer);
      queueReconciliation(operations, generation);
    }, reconciliationRetryMs);
    reconciliationTimers.add(timer);
    timer.unref?.();
  }

  const configStore = createConfigStore({
    getConfigPath: () => options.configPath,
    ...(configFile === undefined ? {} : { file: configFile }),
    accountRemovals,
    enqueue: queue,
    onReconciliationNeeded: (operations) => {
      queueReconciliation(operations);
    },
    repository,
    verify: (candidate) => commitConfig(ConfigSchema.parse(candidate), "config-store"),
  });

  function pluginSummaries(): readonly DashboardPluginSummary[] {
    const lease = manager.acquire();
    try {
      const active = lease.snapshot as Snapshot;
      return [...active.plugins.plugins.values()];
    } finally {
      lease.release();
    }
  }

  async function providerSummaries({
    filter,
    probe,
  }: ProviderSummaryOptions): Promise<readonly DashboardProviderSummary[]> {
    const lease = manager.acquire();
    try {
      const active = lease.snapshot as Snapshot;
      const rows = active.summaries.filter((provider) => filter === undefined || provider.id === filter);
      if (!probe) return rows.map((provider) => mergeStatus(provider, statuses.get(provider.id)));
      return await Promise.all(
        rows.map(async (provider) => {
          const started = performance.now();
          const probeStatus = await runProbe(provider.id, active.probes);
          const status = { last_latency: Math.round(performance.now() - started), last_status: probeStatus };
          statuses.set(provider.id, status);
          return { ...provider, ...status, probe: probeStatus };
        }),
      );
    } finally {
      lease.release();
    }
  }

  async function runRecovery(generation: number): Promise<void> {
    if (closed || generation !== recoveryGeneration || configFile === undefined) return;
    try {
      const result = await recoverAccounts(
        configFile,
        repository,
        { mode: "server", canDeleteAccount: manager.canDeleteAccount, now: recoveryScheduler.now },
        { factory: diagnostics, logger: pluginLogger },
      );
      if (closed || generation !== recoveryGeneration) return;
      if (result.nextRunAt !== undefined) scheduleRecovery(result.nextRunAt, generation);
    } catch (error) {
      if (closed || generation !== recoveryGeneration) return;
      scheduleRecovery(recoveryScheduler.now() + RECOVERY_DRAIN_RETRY_MS, generation);
      try {
        pluginLogger({
          event: "plugin.account.recovery.failed",
          code: "ACCOUNT_RECOVERY_FAILED",
          context: {},
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: "Pending account recovery failed",
          },
        });
      } catch {}
    }
  }

  function scheduleRecovery(nextRunAt: number, generation = recoveryGeneration): void {
    if (closed || generation !== recoveryGeneration) return;
    if (recoveryTimer !== undefined && recoveryRunAt !== undefined && recoveryRunAt <= nextRunAt) return;
    recoveryTimer?.clear();
    recoveryRunAt = nextRunAt;
    recoveryTimer = recoveryScheduler.setTimeout(
      () => {
        recoveryTimer = undefined;
        recoveryRunAt = undefined;
        if (closed || generation !== recoveryGeneration) return;
        void runRecovery(generation);
      },
      Math.max(0, nextRunAt - recoveryScheduler.now()),
    );
  }

  if (configFile !== undefined) {
    const recovered = await recoverAccounts(
      configFile,
      repository,
      { mode: "server", canDeleteAccount: manager.canDeleteAccount, now: recoveryScheduler.now },
      { factory: diagnostics, logger: pluginLogger },
    );
    if (recovered.nextRunAt !== undefined) scheduleRecovery(recovered.nextRunAt);
  }

  const watcher =
    options.configPath !== undefined && options.watchConfig !== false
      ? watchConfigFile(options.configPath, reload)
      : undefined;

  return {
    acquireProviderSnapshot: manager.acquire,
    close() {
      if (closed) return;
      closed = true;
      recoveryGeneration++;
      watcher?.close();
      scheduler.close();
      if (recoveryTimer !== undefined) {
        recoveryTimer.clear();
        recoveryTimer = undefined;
        recoveryRunAt = undefined;
      }
      for (const timer of reconciliationTimers) clearTimeout(timer);
      reconciliationTimers.clear();
      events.close();
      dbHandle.close();
    },
    configPath: options.configPath,
    configStore,
    currentProviderSnapshot: manager.current,
    events,
    pluginSummaries,
    providerSummaries,
    currentConfig: () => (manager.current() as Snapshot).config,
    modelsDevCatalog,
    reload,
    requestLog,
    requestRecorder,
    usageCapture,
  };
}

async function buildSnapshot(
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
      if (pluginOptionsDigest === undefined) throw new Error(`Missing plugin options digest for ${provider.plugin}`);
      return materializePluginProvider({
        config: provider,
        plugins,
        repository,
        diagnostics,
        logger,
        onDiagnosticChanged,
        pluginOptionsDigest,
        ...(previousEntry === undefined ? {} : { previous: previousEntry }),
      });
    }),
  );
  const providerById = new Map(
    [...base.providers, ...oauth.flatMap((item) => (item.provider === undefined ? [] : [item.provider]))].map(
      (provider) => [provider.id, provider] as const,
    ),
  );
  const providers = config.providers.flatMap((configured) => {
    const provider = providerById.get(configured.id);
    return provider === undefined ? [] : [provider];
  });
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
    ...config.providers.flatMap((configured) => {
      const summary = summaryById.get(configured.id);
      return summary === undefined ? [] : [summary];
    }),
  ];
  const assembledStates = new Map<string, ProviderState>();
  for (const provider of nonOAuth.providers) assembledStates.set(provider.id, { status: "ready" });
  for (const invalid of config.invalidProviders) {
    assembledStates.set(invalid.id, {
      status: "unavailable",
      diagnostic: diagnostics(invalid.code, {
        providerId: invalid.id,
        retryable: false,
      }),
    });
  }
  oauth.forEach((item, index) => {
    const provider = oauthConfigs[index];
    if (provider !== undefined) assembledStates.set(provider.id, item.state);
  });
  const configuredById = new Map(config.providers.map((provider) => [provider.id, provider] as const));
  const accountById = new Map(repository.listAccounts().map((account) => [account.providerId, account] as const));
  const summaries = summaryBases.map((summary): DashboardProviderSummary => {
    const state = assembledStates.get(summary.id);
    if (state === undefined) throw new Error(`Provider state missing for ${summary.id}`);
    const configured = configuredById.get(summary.id);
    if (configured?.kind !== ProviderKind.OAuth) return { ...summary, state };
    const account = accountById.get(summary.id);
    const matchingAccount =
      account?.plugin === configured.plugin && account.capability === configured.capability ? account : undefined;
    const catalog = matchingAccount === undefined ? null : repository.readCatalog(summary.id);
    return {
      ...summary,
      state,
      plugin: configured.plugin,
      capability: configured.capability,
      ...(matchingAccount?.label === undefined ? {} : { accountLabel: matchingAccount.label }),
      ...(matchingAccount?.expiresAt === undefined ? {} : { expiresAt: matchingAccount.expiresAt }),
      ...(catalog === null ? {} : { catalogLastSuccessAt: new Date(catalog.refreshedAt).toISOString() }),
    };
  });
  return {
    config,
    plugins,
    probes: base.probes,
    providers,
    router: createRouter(providers),
    summaries,
    catalogJobs: oauth.flatMap((item) => (item.catalogJob === undefined ? [] : [item.catalogJob])),
    runtimeCache: new Map(
      oauth.flatMap((item) => (item.cacheEntry === undefined ? [] : [[item.summary.id, item.cacheEntry] as const])),
    ),
    providerStates: providerStatesFromSummaries(summaries),
  };
}

function providerConfigRecord(config: Config): Record<string, unknown> {
  return Object.fromEntries([
    ...config.providers.map(({ id, ...provider }) => [id, provider] as const),
    ...config.invalidProviders.map(({ id, kind }) => [id, kind === undefined ? {} : { kind }] as const),
  ]);
}

function buildSnapshotWithProviders(
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

function emptyPluginSnapshot(): PluginRegistrySnapshot {
  return {
    registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] },
    plugins: new Map(),
  };
}

function openServerDb(options: ServerStateOptions): OpenDbHandle {
  if (options.dbHome !== undefined) return openDb({ home: options.dbHome });
  return options.configPath === undefined ? openDb() : openDb({ home: dirname(options.configPath) });
}

export function createModelsDevCatalogTask(
  fetchProviders?: FetchModelsDevProviders,
): () => Promise<ModelsDevCatalog | undefined> {
  let catalog: { readonly expiresAt: number; readonly task: Promise<ModelsDevCatalog | undefined> } | undefined;
  return () => {
    const now = Date.now();
    if (catalog === undefined || catalog.expiresAt <= now) {
      catalog = {
        expiresAt: now + PRICE_CATALOG_TTL_MS,
        task: createModelsDevCatalog(fetchProviders).catch((error: unknown) => {
          if (error instanceof Error) return undefined;
          throw error;
        }),
      };
    }
    return catalog.task;
  };
}

function reloadError(error: unknown): ReloadFailure {
  if (error instanceof SyntaxError || error instanceof ZodError)
    return { ok: false, error: error.message, stage: "parse" };
  if (error instanceof Error) {
    return {
      ok: false,
      error: error.message,
      stage: error.name === "RouterModelCollisionError" ? "alias-collision" : "providers",
    };
  }
  return { ok: false, error: String(error), stage: "providers" };
}

function mergeStatus(provider: DashboardProviderSummary, status: ProviderStatus | undefined): DashboardProviderSummary {
  return status === undefined ? provider : { ...provider, ...status };
}

async function runProbe(
  providerId: string,
  probes: ReadonlyMap<string, ProviderProbe>,
): Promise<DashboardProviderProbe> {
  return (await probes.get(providerId)?.()) ?? "OK";
}

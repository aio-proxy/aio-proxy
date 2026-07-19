import {
  AtomicConfigFile,
  createModelsDevCatalog,
  createPluginDiagnosticFactory,
  createPluginRepository,
  type DiagnosticFactory,
  type FetchModelsDevProviders,
  type ModelsDevCatalog,
  type PendingAccountOperation,
  type PluginLogSink,
  RECOVERY_DRAIN_RETRY_MS,
  Router,
  recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { createRequestLogStore, type OpenDbHandle, openDb } from "@aio-proxy/core/db";
import {
  type Config,
  ConfigSchema,
  type DashboardOAuthCapability,
  DashboardOAuthProviderEditSchema,
} from "@aio-proxy/types";
import { dirname } from "node:path";

import type { RetiredProviderSnapshot, RuntimeProviderInstance } from "../runtime";
import type { ServerLogSink } from "../server-log";
import type { ConfigReloadResult, InternalServerStateOptions, ServerState, ServerStateOptions } from "./types";

import { createAccountRemovalCoordinator } from "../account-removal";
import { CatalogScheduler } from "../catalog-scheduler";
import { createConfigStore } from "../config-store";
import { watchConfigFile } from "../config-watcher";
import { createDashboardEventHub } from "../dashboard-events";
import { dashboardOAuthCapabilities, dashboardOAuthForm } from "../dashboard-routes/oauth-capabilities";
import { createFifoQueue } from "../fifo-queue";
import { LogicalSessionStore } from "../logical-session-store";
import { createOAuthLoginSessionManager } from "../oauth-login-session/manager";
import { createOAuthQuotaOperations } from "../plugin-quota";
import { createSnapshotManager } from "../plugin-snapshot";
import { providerDiff } from "../provider-runtime";
import { createRequestRecorder } from "../request-recorder";
import { createUsageCapture } from "../usage-capture";
import { createProviderSummaries } from "./probe";
import { createRecovery, defaultRecoveryScheduler, recoverBeforeSnapshot } from "./recovery";
import { reloadSnapshot } from "./reload";
import { buildSnapshot, buildSnapshotWithProviders, providerConfigRecord, type Snapshot } from "./snapshot";

const defaultLogger: ServerLogSink = (entry) => console.error(JSON.stringify(entry));
const defaultPluginLogger: PluginLogSink = (entry) => console.error(JSON.stringify(entry));
const PRICE_CATALOG_TTL_MS = 6 * 60 * 60 * 1_000;

export function createServerDiagnosticFactory(now: () => number = Date.now): DiagnosticFactory {
  return createPluginDiagnosticFactory(now);
}

export async function createServerState(options: ServerStateOptions): Promise<ServerState> {
  const testHooks = (options as InternalServerStateOptions).__test;
  const createRouter =
    testHooks?.createRouter ?? ((providers: readonly RuntimeProviderInstance[]) => new Router(providers));
  const events = createDashboardEventHub(options.eventLimits);
  const dbHandle = openServerDb(options);
  const repository = options.pluginRepository ?? createPluginRepository(dbHandle.sqlite);
  const diagnostics = createServerDiagnosticFactory();
  const pluginLogger = options.pluginLogger ?? defaultPluginLogger;
  const configFile =
    testHooks?.configFile ?? (options.configPath === undefined ? undefined : new AtomicConfigFile(options.configPath));
  const recoverAccounts = testHooks?.recoverPendingAccountOperations ?? recoverPendingAccountOperations;
  const recoveryScheduler = testHooks?.recoveryScheduler ?? defaultRecoveryScheduler();
  const queue = createFifoQueue();
  let manager: ReturnType<typeof createSnapshotManager>;
  let managerReady = false;
  let closed = false;

  await recoverBeforeSnapshot({
    configFile,
    repository,
    diagnostics,
    logger: pluginLogger,
    recoverAccounts,
    scheduler: recoveryScheduler,
    enqueue: queue,
  });

  let startupDiagnosticRebuildPending = false;
  const queueRebuild = () => {
    if (closed) return;
    if (!managerReady) {
      startupDiagnosticRebuildPending = true;
      return;
    }
    void queue(async () => {
      if (!closed) await commitConfig((manager.current() as Snapshot).config, "credential-diagnostic");
    }).catch(() => {});
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
  const oauthQuota = createOAuthQuotaOperations({
    acquireSnapshot: manager.acquire,
    repository,
    diagnostics,
    logger: pluginLogger,
    onDiagnosticChanged: queueRebuild,
  });
  let recovery: ReturnType<typeof createRecovery> | undefined;
  const accountRemovals = createAccountRemovalCoordinator({
    file: configFile,
    repository,
    enqueue: queue,
    canDeleteAccount: manager.canDeleteAccount,
    onRecoveryNeeded: (nextRunAt) => recovery?.schedule(nextRunAt),
  });
  const scheduler = new CatalogScheduler({
    repository,
    diagnostics,
    rebuild: () => queue(() => commitConfig((manager.current() as Snapshot).config, "catalog")),
  });
  const replaceCatalogJobs = (jobs: Snapshot["catalogJobs"]): void => {
    scheduler.replaceJobs(jobs);
    testHooks?.onCatalogJobsReplaced?.(jobs);
  };
  if (startupDiagnosticRebuildPending) {
    startupDiagnosticRebuildPending = false;
    await queue(() => commitConfig((manager.current() as Snapshot).config, "credential-diagnostic"));
  } else replaceCatalogJobs(initial.catalogJobs);

  const requestLog = createRequestLogStore(dbHandle.db);
  const modelsDevCatalog = options.modelsDevCatalogTask ?? createModelsDevCatalogTask();
  const usageCapture = createUsageCapture({ priceCatalogTask: modelsDevCatalog });
  const logger = options.logger ?? defaultLogger;
  const requestRecorder = createRequestRecorder({ store: requestLog, logger });
  const logicalSessionStore = new LogicalSessionStore();

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
    replaceCatalogJobs(candidate.catalogJobs);
    events.publish({ event: "config.changed", data: providerDiff(before, candidate.summaries) });
    accountRemovals.cancelReadded(providerConfigRecord(previous.config), providerConfigRecord(config));
    return retired;
  }

  const reloadNow = (retainedOperations: readonly PendingAccountOperation[] = []) =>
    reloadSnapshot({ accountRemovals, commitConfig, configFile, logger, manager, retainedOperations });

  recovery = createRecovery({
    configFile,
    repository,
    diagnostics,
    logger: pluginLogger,
    recoverAccounts,
    scheduler: recoveryScheduler,
    reconciliationRetryMs: testHooks?.reconciliationRetryMs ?? RECOVERY_DRAIN_RETRY_MS,
    enqueue: queue,
    canDeleteAccount: manager.canDeleteAccount,
    reloadNow,
  });
  await recovery.start();
  const configStore = createConfigStore({
    getConfigPath: () => options.configPath,
    ...(configFile === undefined ? {} : { file: configFile }),
    accountRemovals,
    enqueue: queue,
    onReconciliationNeeded: recovery.scheduleReconciliation,
    repository,
    verify: (candidate) => commitConfig(ConfigSchema.parse(candidate), "config-store"),
  });

  function oauthCapabilities(): readonly DashboardOAuthCapability[] {
    const lease = manager.acquire();
    try {
      return dashboardOAuthCapabilities((lease.snapshot as Snapshot).plugins.registry);
    } finally {
      lease.release();
    }
  }

  function oauthProviderEditView(providerId: string) {
    const lease = manager.acquire();
    try {
      const snapshot = lease.snapshot as Snapshot;
      const provider = snapshot.config.providers.find((candidate) => candidate.id === providerId);
      if (provider?.kind !== "oauth") return undefined;
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

  const providerSummaries = createProviderSummaries(manager);

  const reload = (): Promise<ConfigReloadResult> => queue(() => reloadNow());
  const oauthLoginSessions = createOAuthLoginSessionManager({
    configFile,
    repository,
    acquireRegistry: () => {
      const lease = manager.acquire();
      return {
        registry: (lease.snapshot as Snapshot).plugins.registry,
        release: lease.release,
      };
    },
    diagnostics,
    logger: pluginLogger,
    reload,
    now: testHooks?.oauthSessionNow,
    terminalSessionTtlMs: testHooks?.oauthSessionTtlMs,
  });
  const watcher =
    options.configPath !== undefined && options.watchConfig !== false
      ? watchConfigFile(options.configPath, reload)
      : undefined;
  return {
    acquireProviderSnapshot: manager.acquire,
    close() {
      if (closed) return;
      closed = true;
      watcher?.close();
      scheduler.close();
      recovery?.close();
      oauthLoginSessions.close();
      events.close();
      dbHandle.close();
    },
    configPath: options.configPath,
    configStore,
    currentProviderSnapshot: manager.current,
    events,
    logicalSessionStore,
    oauthCapabilities,
    oauthProviderEditView,
    oauthLoginSessions,
    providerSummaries,
    currentConfig: () => (manager.current() as Snapshot).config,
    modelsDevCatalog,
    oauthQuota,
    reload,
    requestLog,
    logger,
    requestRecorder,
    usageCapture,
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

export type {
  ConfigReloadLog,
  ConfigReloadResult,
  ProviderSummaryOptions,
  ServerState,
  ServerStateOptions,
} from "./types";

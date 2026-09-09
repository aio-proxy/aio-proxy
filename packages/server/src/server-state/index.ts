import { dirname } from 'node:path';

import {
  AtomicConfigFile,
  createAgentIdentityService,
  createEmbeddedBuiltIns,
  createOAuthProviderGate,
  createPluginDiagnosticFactory,
  createPluginRepository,
  createSyncRepository,
  type DiagnosticFactory,
  pluginDefaultAliases,
  RECOVERY_DRAIN_RETRY_MS,
  Router,
  recoverPendingAccountOperations,
} from '@aio-proxy/core';
import type { OAuthSharingService, SharedOAuthCoordinator } from '@aio-proxy/core';
import {
  acquireDatabaseOwnershipLock,
  assertSafeOwnedDatabaseFile,
  createTraceStore,
  type DatabaseOwnershipLock,
  type OpenDbHandle,
  type OpenDbOptions,
  openDb,
  resolveDbPath,
} from '@aio-proxy/core/db';

import type { AccountRemovalCoordinator } from '../account-removal';
import { createAccountRemovalCoordinator } from '../account-removal';
import { CatalogScheduler } from '../catalog-scheduler';
import type { ConfigStore } from '../config-store';
import { watchConfigFile } from '../config-watcher';
import { createOAuthCredentialRefresher } from '../credential-refresh';
import { createDashboardEventHub } from '../dashboard-events';
import { createFifoQueue } from '../fifo-queue';
import { LogicalSessionStore } from '../logical-session-store';
import { createModelRoutingControlPlane } from '../model-routing';
import { createPluginControlPlane } from '../plugin-control-plane';
import { createOAuthQuotaCache, createOAuthQuotaOperations } from '../plugin-quota';
import type { SnapshotManager } from '../plugin-snapshot';
import { createSnapshotManager } from '../plugin-snapshot';
import { createRequestTraceRecorder } from '../request-tracing';
import { ProviderCooldownStore } from '../routes/pipeline/provider-cooldown';
import { createRealtimeCallStore } from '../routes/realtime';
import { createUsageCapture } from '../usage-capture';
import type { ServerRuntime } from './lifecycle';
import {
  assembleServerState,
  commitConfig,
  queueRebuild,
  reloadNow,
  replaceCatalogJobs,
  startLoginSessions,
  startRecovery,
} from './lifecycle';
import { defaultLogger, defaultPluginLogger } from './logging';
import { createProviderSummaries } from './probe';
import { createQuotaIdentityTracker } from './quota-invalidation';
import { defaultRecoveryScheduler } from './recovery';
import { createSharedCredentialResolver } from './shared-credential-resolver';
import { buildSnapshot, buildSnapshotWithProviders, emptyPluginSnapshot, type Snapshot } from './snapshot';
import { recoverBeforeInitialSnapshot } from './startup-recovery';
import { createSyncIntegration, syncCommitOption, startSyncIntegration } from './sync-integration';
import type {
  ConfigReloadResult,
  InternalServerStateOptions,
  ServerState,
  ServerStateOptions,
  ServerStateTestHooks,
} from './types';

export function createServerDiagnosticFactory(now: () => number = Date.now): DiagnosticFactory {
  return createPluginDiagnosticFactory(now);
}

function serverDbOptions(options: ServerStateOptions): OpenDbOptions {
  if (options.dbHome !== undefined) return { home: options.dbHome };
  return options.configPath === undefined ? {} : { home: dirname(options.configPath) };
}

function createStartupCleanup() {
  const cleanups: Array<() => void | Promise<void>> = [];
  let armed = true;
  return {
    add(cleanup: () => void | Promise<void>) {
      if (!armed) throw new Error('startup cleanup is already disarmed');
      cleanups.push(cleanup);
    },
    async unwind() {
      if (!armed) return;
      armed = false;
      for (const cleanup of cleanups.reverse())
        await Promise.resolve()
          .then(cleanup)
          .catch(() => {});
      cleanups.length = 0;
    },
    disarm() {
      armed = false;
      cleanups.length = 0;
    },
  };
}

export async function createServerState(options: ServerStateOptions): Promise<ServerState> {
  const dbOptions = serverDbOptions(options);
  const startup = createStartupCleanup();
  const databaseOwnership = await acquireDatabaseOwnershipLock(resolveDbPath(dbOptions));
  startup.add(databaseOwnership.release);
  try {
    const dbHandle = openDb({ home: dirname(databaseOwnership.databasePath) });
    startup.add(dbHandle.close);
    assertSafeOwnedDatabaseFile(databaseOwnership.databasePath);
    const state = await initializeServerState(options, dbHandle, databaseOwnership, startup.add);
    startup.disarm();
    return state;
  } catch (error) {
    await startup.unwind();
    throw error;
  }
}

// eslint-disable-next-line max-lines-per-function -- startup ordering is intentionally kept together
async function initializeServerState(
  options: ServerStateOptions,
  dbHandle: OpenDbHandle,
  databaseOwnership: DatabaseOwnershipLock,
  registerStartupCleanup: (cleanup: () => void | Promise<void>) => void,
): Promise<ServerState> {
  const internalOptions = options as InternalServerStateOptions;
  const testHooks = internalOptions.__test;
  const agentIdentity = testHooks?.agentIdentity ?? createAgentIdentityService(dbHandle.sqlite);
  type StartupResource = NonNullable<ServerStateTestHooks['failStartupAfter']>;
  const failAfter = (resource: StartupResource): void => {
    if (testHooks?.failStartupAfter === resource) {
      throw new Error(`injected startup failure: ${resource}`);
    }
  };
  const createRouter =
    testHooks?.createRouter ?? ((providers, routerConfig) => new Router(providers, { models: routerConfig.models }));
  const events = createDashboardEventHub(options.eventLimits);
  registerStartupCleanup(() => events.close());
  const repository = options.pluginRepository ?? createPluginRepository(dbHandle.sqlite);
  const syncRepository = createSyncRepository(dbHandle.sqlite);
  const providerGate = createOAuthProviderGate();
  let sharedCoordinator: SharedOAuthCoordinator | undefined;
  let oauthSharing: OAuthSharingService | undefined;
  let installedPlugins = emptyPluginSnapshot();
  const resolveSharedCredential = createSharedCredentialResolver(
    syncRepository,
    repository,
    () => sharedCoordinator,
    (providerId) => {
      const account = repository.readAccount(providerId);
      if (account === null) return undefined;
      const adapter = installedPlugins.registry.resolveOAuth(account.plugin, account.capability);
      const pluginVersion = installedPlugins.plugins.get(account.plugin)?.version;
      return adapter === undefined || pluginVersion === undefined ? undefined : { adapter, pluginVersion };
    },
  );
  const diagnostics = createServerDiagnosticFactory();
  const pluginLogger = options.pluginLogger ?? defaultPluginLogger;
  const logger = options.logger ?? defaultLogger;
  const configFile =
    testHooks?.configFile ?? (options.configPath === undefined ? undefined : new AtomicConfigFile(options.configPath));
  const rawRecoverAccounts = testHooks?.recoverPendingAccountOperations ?? recoverPendingAccountOperations;
  const recoverAccounts: typeof recoverPendingAccountOperations = (
    file,
    accounts,
    recoveryOptions,
    diagnosticOptions,
  ) =>
    rawRecoverAccounts(
      file,
      accounts,
      recoveryOptions.mode === 'cli'
        ? recoveryOptions
        : {
            ...recoveryOptions,
            beforeAccountOperationComplete: async (operation, signal) => {
              if (oauthSharing === undefined) throw new Error('SYNC_OAUTH_COORDINATION_UNAVAILABLE');
              const account = accounts.readAccount(operation.providerId);
              if (account === null || account.revision !== operation.appliedRevision)
                throw new Error('SYNC_OAUTH_LOGIN_CONFLICT');
              await oauthSharing.synchronizeLogin(
                operation.providerId,
                { ...account, catalog: { kind: 'preserve' } },
                signal,
              );
            },
          },
      diagnosticOptions,
    );
  const recoveryScheduler = testHooks?.recoveryScheduler ?? defaultRecoveryScheduler();
  const queue = createFifoQueue();

  const runtime: ServerRuntime = {
    options,
    internalOptions,
    repository,
    diagnostics,
    pluginLogger,
    logger,
    queue,
    events,
    createRouter,
    manager: undefined as unknown as SnapshotManager,
    managerReady: false,
    closed: false,
    startupDiagnosticRebuildPending: false,
    accountRemovals: undefined as unknown as AccountRemovalCoordinator,
    scheduler: undefined as unknown as CatalogScheduler,
    quotaCache: undefined,
    quotaIdentity: undefined,
    recovery: undefined,
    configFile,
    sync: undefined,
    syncCommit: undefined,
    resolveSharedCredential,
    withProviderGate: providerGate.run,
  };

  let syncIntegration: ReturnType<typeof createSyncIntegration> | undefined;
  runtime.prepareOAuth = async (plugins) => {
    installedPlugins = plugins;
    if (syncIntegration !== undefined) return;
    syncIntegration = createSyncIntegration(
      runtime,
      dbHandle,
      repository,
      () => installedPlugins,
      configFile,
      options,
      queue,
      syncRepository,
      (coordinator) => {
        sharedCoordinator = coordinator;
      },
      (sharing) => {
        oauthSharing = sharing;
      },
    );
    runtime.syncCommit = syncCommitOption(syncIntegration);
    await startSyncIntegration(runtime, syncIntegration, registerStartupCleanup);
    await recoverBeforeInitialSnapshot(runtime, recoverAccounts, recoveryScheduler);
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
          () => queueRebuild(runtime),
          createRouter,
          resolveSharedCredential,
          providerGate.run,
          runtime.prepareOAuth,
        )
      : buildSnapshotWithProviders(options.config, options.providerInstances, createRouter);
  if (syncIntegration === undefined) await runtime.prepareOAuth(initial.plugins);
  const syncCommit = runtime.syncCommit;
  runtime.manager = createSnapshotManager(initial);
  const manager = runtime.manager;
  runtime.managerReady = true;
  const { oauthQuota, oauthCredentialRefresh, quotaCache } = createQuotaServices(runtime, manager);
  runtime.accountRemovals = createAccountRemovalCoordinator({
    file: configFile,
    repository,
    enqueue: queue,
    canDeleteAccount: manager.canDeleteAccount,
    withProviderGate: runtime.withProviderGate,
    onRecoveryNeeded: (nextRunAt) => runtime.recovery?.schedule(nextRunAt),
  });
  runtime.scheduler = new CatalogScheduler({
    repository,
    diagnostics,
    logger: pluginLogger,
    rebuild: () => queue(() => commitConfig(runtime, (manager.current() as Snapshot).config, 'catalog')),
  });
  registerStartupCleanup(() => runtime.scheduler.close());
  failAfter('scheduler');
  if (runtime.startupDiagnosticRebuildPending) {
    runtime.startupDiagnosticRebuildPending = false;
    await queue(() => commitConfig(runtime, (manager.current() as Snapshot).config, 'credential-diagnostic'));
  } else replaceCatalogJobs(runtime, initial.catalogJobs);

  const traceStore = createTraceStore(dbHandle.db);
  const usageCapture = createUsageCapture({ logger });
  const logicalSessionStore = new LogicalSessionStore({ repository: traceStore, logger });
  const cooldown = new ProviderCooldownStore();
  const realtimeCalls = createRealtimeCallStore();
  const requestRecorder = createRequestTraceRecorder({
    store: traceStore,
    logger,
    onResponsePersisted: (responseId) => logicalSessionStore.reconcilePersistedResponse(responseId),
  });

  const configStore = await startRecovery(
    runtime,
    {
      recoverAccounts,
      recoveryScheduler,
      reconciliationRetryMs: testHooks?.reconciliationRetryMs ?? RECOVERY_DRAIN_RETRY_MS,
      ...(syncCommit === undefined ? {} : { syncCommit }),
    },
    registerStartupCleanup,
  );
  failAfter('recovery');
  const pluginControlPlane = createStatePluginControlPlane(runtime, configStore);
  const modelRouting = createModelRoutingControlPlane({
    currentConfig: () => (manager.current() as Snapshot).config,
    currentSummaries: () => (manager.current() as Snapshot).summaries,
    repository,
    configStore,
    pluginDefaults: (provider) => {
      const adapter = (manager.current() as Snapshot).plugins.registry.resolveOAuth(
        provider.plugin,
        provider.capability,
      );
      const catalog = repository.readCatalog(provider.id)?.catalog;
      if (adapter === undefined || catalog === undefined) return undefined;
      return pluginDefaultAliases(adapter, catalog);
    },
  });

  runtime.sync?.activate();

  const providerSummaries = createProviderSummaries(manager);

  const reload = (): Promise<ConfigReloadResult> => queue(() => reloadNow(runtime));
  const oauthLoginSessions = startLoginSessions(
    runtime,
    configStore,
    reload,
    syncCommit,
    syncRepository.bindings().length === 0 ? undefined : () => oauthSharing,
  );
  registerStartupCleanup(() => oauthLoginSessions.close());
  failAfter('login_sessions');
  const watcher =
    options.configPath !== undefined && options.watchConfig !== false
      ? watchConfigFile(options.configPath, reload)
      : undefined;
  if (watcher !== undefined) registerStartupCleanup(() => watcher.close());
  failAfter('watcher');
  return assembleServerState(runtime, {
    agentIdentity,
    manager,
    dbHandle,
    databaseOwnership,
    configStore,
    events,
    logicalSessionStore,
    cooldown,
    modelRouting,
    oauthQuota,
    oauthCredentialRefresh,
    quotaCache,
    realtimeCalls,
    oauthLoginSessions,
    pluginControlPlane,
    providerSummaries,
    reload,
    traceStore,
    requestRecorder,
    usageCapture,
    watcher,
    closeRecovery: () => runtime.recovery?.close(),
    sync: runtime.sync,
  });
}

// Called once per server so cache invalidation and per-Provider serialization share one state owner.
function createQuotaServices(runtime: ServerRuntime, manager: SnapshotManager) {
  const dependencies = {
    acquireSnapshot: manager.acquire,
    repository: runtime.repository,
    diagnostics: runtime.diagnostics,
    logger: runtime.pluginLogger,
    onDiagnosticChanged: () => queueRebuild(runtime),
    resolveShared: runtime.resolveSharedCredential,
    withProviderGate: runtime.withProviderGate,
  };
  const oauthQuota = createOAuthQuotaOperations(dependencies);
  const oauthCredentialRefresh = createOAuthCredentialRefresher(dependencies);
  const quotaCache = createOAuthQuotaCache(oauthQuota);
  runtime.quotaCache = quotaCache;
  runtime.quotaIdentity = createQuotaIdentityTracker(quotaCache, manager.current() as Snapshot);
  return { oauthQuota, oauthCredentialRefresh, quotaCache };
}

function createStatePluginControlPlane(runtime: ServerRuntime, configStore: ConfigStore) {
  const { options, diagnostics, repository } = runtime;
  return createPluginControlPlane({
    acquireSnapshot: runtime.manager.acquire,
    builtIns: options.builtIns ?? createEmbeddedBuiltIns(),
    configStore,
    diagnostics,
    importPackage: options.importPlugin ?? (async ({ entrypoint }) => import(entrypoint)),
    repository,
    ...runtime.internalOptions.__test?.pluginControlPlane,
  });
}

export type {
  ConfigReloadLog,
  ConfigReloadResult,
  ProviderSummaryOptions,
  ServerState,
  ServerStateOptions,
} from './types';

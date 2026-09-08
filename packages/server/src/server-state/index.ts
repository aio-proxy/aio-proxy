import { dirname } from 'node:path';

import {
  AtomicConfigFile,
  createAgentIdentityService,
  createEmbeddedBuiltIns,
  createPluginDiagnosticFactory,
  createPluginRepository,
  createSyncRepository,
  parseRuntimeConfig,
  parsePluginSchema,
  type DiagnosticFactory,
  type PluginRepository,
  pluginDefaultAliases,
  RECOVERY_DRAIN_RETRY_MS,
  Router,
  recoverPendingAccountOperations,
  type JsonValue,
} from '@aio-proxy/core';
import type { SharedOAuthCoordinator } from '@aio-proxy/core';
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
import {
  checkPrerequisites,
  createLocalSyncPort,
  createServerSyncLifecycle,
  readOAuthActivationEvidence,
  type OAuthActivationEvidence,
} from '../sync-control-plane';
import { createSyncCommitHooks } from '../sync-control-plane/commit';
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
import { buildSnapshot, buildSnapshotWithProviders, type Snapshot } from './snapshot';
import { recoverBeforeInitialSnapshot } from './startup-recovery';
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

function createSyncIntegration(
  runtime: ServerRuntime,
  dbHandle: OpenDbHandle,
  repository: PluginRepository,
  manager: SnapshotManager,
  configFile: AtomicConfigFile | undefined,
  options: ServerStateOptions,
  queue: ReturnType<typeof createFifoQueue>,
  syncRepository = createSyncRepository(dbHandle.sqlite),
  onCoordinator?: (coordinator: SharedOAuthCoordinator | undefined) => void,
) {
  const syncBinding = syncRepository.readBinding();
  if (syncBinding === null || configFile === undefined || options.configPath === undefined) {
    return {
      syncRepository,
      syncBinding,
      syncPort: undefined,
      syncApplyCandidate: async () => {},
      lifecycle: undefined,
      configPath: options.configPath,
    };
  }
  const syncApplyCandidate = async (raw: Record<string, JsonValue>, origin: 'local' | 'remote'): Promise<void> => {
    await configFile.replace(() => raw, {
      validateCandidate: (candidate) => void parseRuntimeConfig(candidate),
      verify: async (candidate) => {
        await commitConfig(runtime, parseRuntimeConfig(candidate), origin === 'remote' ? 'sync-remote' : 'sync-local');
      },
    });
  };
  const pluginVersions = () =>
    new Map(
      [...(manager.current() as Snapshot).plugins.plugins]
        .filter(([, plugin]) => plugin.version !== undefined)
        .map(([name, plugin]) => [name, plugin.version!] as const),
    );
  const checkActivation = async (raw: Record<string, JsonValue>, body: import('@aio-proxy/core').EntityBody) => {
    let credentialValid = true;
    let oauthEvidence: OAuthActivationEvidence | undefined;
    const value = body.value;
    if (
      body.kind === 'provider' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, JsonValue>)['kind'] === 'oauth'
    ) {
      const valueRecord = value as Record<string, JsonValue>;
      const plugin = typeof valueRecord['plugin'] === 'string' ? valueRecord['plugin'] : undefined;
      const capability = typeof valueRecord['capability'] === 'string' ? valueRecord['capability'] : undefined;
      const adapter =
        plugin === undefined || capability === undefined
          ? undefined
          : (manager.current() as Snapshot).plugins.registry.resolveOAuth(plugin, capability);
      const account = repository.readAccount(body.logicalKey);
      if (
        plugin === undefined ||
        capability === undefined ||
        adapter === undefined ||
        account === null ||
        account.plugin !== plugin ||
        account.capability !== capability
      )
        credentialValid = false;
      else {
        credentialValid = (await parsePluginSchema(adapter.credentials, account.credential)).ok;
        oauthEvidence = readOAuthActivationEvidence(
          account,
          adapter.credentialSync?.formatVersion,
          adapter.credentialSync?.multiDevice?.evidenceId,
        );
      }
    }
    return checkPrerequisites({
      raw,
      body,
      apply: async () => {},
      dependencies: {
        installedPackages: pluginVersions(),
        missingEnv: [],
        oauthVerified: credentialValid,
        credentialValid,
        ...(oauthEvidence === undefined ? {} : { oauthEvidence }),
      },
    });
  };
  const syncPort = createLocalSyncPort({
    configPath: options.configPath,
    configFile,
    repo: syncRepository,
    accounts: repository,
    bindingId: syncBinding.id,
    bindingGeneration: syncBinding.sessionGeneration,
    enqueue: queue,
    registry: () => (manager.current() as Snapshot).plugins.registry,
    applyCandidate: syncApplyCandidate,
    checkActivation,
    pluginVersions,
  });
  const lifecycle = createServerSyncLifecycle({
    configPath: options.configPath,
    configFile,
    repo: syncRepository,
    accounts: repository,
    registry: () => (manager.current() as Snapshot).plugins.registry,
    enqueue: queue,
    applyCandidate: syncApplyCandidate,
    pluginVersions,
    localPort: syncPort,
    onCoordinator,
  });
  return { syncRepository, syncBinding, syncPort, syncApplyCandidate, lifecycle, configPath: options.configPath };
}

function syncCommitOption(integration: ReturnType<typeof createSyncIntegration>) {
  return integration.syncBinding === null || integration.syncPort === undefined
    ? undefined
    : createSyncCommitHooks({
        path: integration.configPath,
        repo: integration.syncRepository,
        bindingId: integration.syncBinding.id,
        port: integration.syncPort,
      });
}

async function startSyncIntegration(
  runtime: ServerRuntime,
  integration: ReturnType<typeof createSyncIntegration>,
  registerStartupCleanup: (cleanup: () => void | Promise<void>) => void,
): Promise<void> {
  if (integration.lifecycle === undefined) return;
  runtime.sync = integration.lifecycle;
  registerStartupCleanup(() => integration.lifecycle?.close());
  try {
    await integration.lifecycle.start();
  } catch (error) {
    await integration.lifecycle.close().catch(() => {});
    throw error;
  }
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
  let sharedCoordinator: SharedOAuthCoordinator | undefined;
  const resolveSharedCredential = createSharedCredentialResolver(syncRepository, repository, () => sharedCoordinator);
  const diagnostics = createServerDiagnosticFactory();
  const pluginLogger = options.pluginLogger ?? defaultPluginLogger;
  const logger = options.logger ?? defaultLogger;
  const configFile =
    testHooks?.configFile ?? (options.configPath === undefined ? undefined : new AtomicConfigFile(options.configPath));
  const recoverAccounts = testHooks?.recoverPendingAccountOperations ?? recoverPendingAccountOperations;
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
  };

  await recoverBeforeInitialSnapshot(runtime, recoverAccounts, recoveryScheduler);

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
        )
      : buildSnapshotWithProviders(options.config, options.providerInstances, createRouter);
  runtime.manager = createSnapshotManager(initial);
  const manager = runtime.manager;
  runtime.managerReady = true;
  const { oauthQuota, oauthCredentialRefresh, quotaCache } = createQuotaServices(runtime, manager);
  runtime.accountRemovals = createAccountRemovalCoordinator({
    file: configFile,
    repository,
    enqueue: queue,
    canDeleteAccount: manager.canDeleteAccount,
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

  const syncIntegration = createSyncIntegration(
    runtime,
    dbHandle,
    repository,
    manager,
    configFile,
    options,
    queue,
    syncRepository,
    (coordinator) => {
      sharedCoordinator = coordinator;
      if (runtime.managerReady) void queueRebuild(runtime);
    },
  );
  const syncCommit = syncCommitOption(syncIntegration);
  runtime.syncCommit = syncCommit;

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

  // Recover durable sync state before starting any watcher or login session that can enqueue a
  // competing config mutation. The lifecycle also rechecks the binding before opening the backend.
  await startSyncIntegration(runtime, syncIntegration, registerStartupCleanup);

  const providerSummaries = createProviderSummaries(manager);

  const reload = (): Promise<ConfigReloadResult> => queue(() => reloadNow(runtime));
  const oauthLoginSessions = startLoginSessions(runtime, configStore, reload, syncCommit);
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

// The cache is published onto the runtime so `commitConfig` can invalidate the entries of Providers
// whose configuration changed; everything in it is keyed by Provider ID alone.
// Called exactly once per server: the refresher's per-Provider-ID serialization lives in a closure,
// so a second instance would mean a second queue and two clicks could race the same credential.
function createQuotaServices(runtime: ServerRuntime, manager: SnapshotManager) {
  const dependencies = {
    acquireSnapshot: manager.acquire,
    repository: runtime.repository,
    diagnostics: runtime.diagnostics,
    logger: runtime.pluginLogger,
    onDiagnosticChanged: () => queueRebuild(runtime),
    resolveShared: runtime.resolveSharedCredential,
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

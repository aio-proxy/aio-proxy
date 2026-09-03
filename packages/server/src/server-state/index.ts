import { dirname } from 'node:path';

import {
  AtomicConfigFile,
  createAgentIdentityService,
  createEmbeddedBuiltIns,
  createPluginDiagnosticFactory,
  createPluginRepository,
  type DiagnosticFactory,
  RECOVERY_DRAIN_RETRY_MS,
  Router,
  recoverPendingAccountOperations,
} from '@aio-proxy/core';
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
import { createDashboardEventHub } from '../dashboard-events';
import { createFifoQueue } from '../fifo-queue';
import { LogicalSessionStore } from '../logical-session-store';
import { createModelRoutingControlPlane } from '../model-routing';
import { createPluginControlPlane } from '../plugin-control-plane';
import { createOAuthQuotaOperations } from '../plugin-quota';
import type { SnapshotManager } from '../plugin-snapshot';
import { createSnapshotManager } from '../plugin-snapshot';
import { createRequestTraceRecorder } from '../request-tracing';
import { ProviderCooldownStore } from '../routes/pipeline/provider-cooldown';
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
import { defaultRecoveryScheduler, recoverBeforeSnapshot } from './recovery';
import { buildSnapshot, buildSnapshotWithProviders, type Snapshot } from './snapshot';
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
  const cleanups: Array<() => void> = [];
  let armed = true;
  return {
    add(cleanup: () => void) {
      if (!armed) throw new Error('startup cleanup is already disarmed');
      cleanups.push(cleanup);
    },
    unwind() {
      if (!armed) return;
      armed = false;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {}
      }
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
    startup.unwind();
    throw error;
  }
}

async function initializeServerState(
  options: ServerStateOptions,
  dbHandle: OpenDbHandle,
  databaseOwnership: DatabaseOwnershipLock,
  registerStartupCleanup: (cleanup: () => void) => void,
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
    recovery: undefined,
    configFile,
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
        )
      : buildSnapshotWithProviders(options.config, options.providerInstances, createRouter);
  runtime.manager = createSnapshotManager(initial);
  const manager = runtime.manager;
  runtime.managerReady = true;
  const oauthQuota = createOAuthQuotaOperations({
    acquireSnapshot: manager.acquire,
    repository,
    diagnostics,
    logger: pluginLogger,
    onDiagnosticChanged: () => queueRebuild(runtime),
  });
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
  });

  const providerSummaries = createProviderSummaries(manager);

  const reload = (): Promise<ConfigReloadResult> => queue(() => reloadNow(runtime));
  const oauthLoginSessions = startLoginSessions(runtime, configStore, reload);
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
    oauthLoginSessions,
    pluginControlPlane,
    providerSummaries,
    reload,
    traceStore,
    requestRecorder,
    usageCapture,
    watcher,
    closeRecovery: () => runtime.recovery?.close(),
  });
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

function recoverBeforeInitialSnapshot(
  runtime: ServerRuntime,
  recoverAccounts: typeof recoverPendingAccountOperations,
  scheduler: ReturnType<typeof defaultRecoveryScheduler>,
) {
  return recoverBeforeSnapshot({
    configFile: runtime.configFile,
    repository: runtime.repository,
    diagnostics: runtime.diagnostics,
    logger: runtime.pluginLogger,
    recoverAccounts,
    scheduler,
    enqueue: runtime.queue,
  });
}

export type {
  ConfigReloadLog,
  ConfigReloadResult,
  ProviderSummaryOptions,
  ServerState,
  ServerStateOptions,
} from './types';

import { dirname } from 'node:path';

import {
  AtomicConfigFile,
  createPluginDiagnosticFactory,
  createPluginRepository,
  type DiagnosticFactory,
  RECOVERY_DRAIN_RETRY_MS,
  Router,
  recoverPendingAccountOperations,
} from '@aio-proxy/core';
import { createRequestLogStore, type OpenDbHandle, openDb } from '@aio-proxy/core/db';

import type { AccountRemovalCoordinator } from '../account-removal';
import { createAccountRemovalCoordinator } from '../account-removal';
import { CatalogScheduler } from '../catalog-scheduler';
import { watchConfigFile } from '../config-watcher';
import { createDashboardEventHub } from '../dashboard-events';
import { createFifoQueue } from '../fifo-queue';
import { LogicalSessionStore } from '../logical-session-store';
import { createOAuthQuotaOperations } from '../plugin-quota';
import type { SnapshotManager } from '../plugin-snapshot';
import { createSnapshotManager } from '../plugin-snapshot';
import { createRequestRecorder } from '../request-recorder';
import type { RuntimeProviderInstance } from '../runtime';
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
import type { ConfigReloadResult, InternalServerStateOptions, ServerState, ServerStateOptions } from './types';

export function createServerDiagnosticFactory(now: () => number = Date.now): DiagnosticFactory {
  return createPluginDiagnosticFactory(now);
}

export async function createServerState(options: ServerStateOptions): Promise<ServerState> {
  const internalOptions = options as InternalServerStateOptions;
  const testHooks = internalOptions.__test;
  const createRouter =
    testHooks?.createRouter ?? ((providers: readonly RuntimeProviderInstance[]) => new Router(providers));
  const events = createDashboardEventHub(options.eventLimits);
  const dbHandle = openServerDb(options);
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
    configFile,
  };

  await recoverBeforeSnapshot({
    configFile,
    repository,
    diagnostics,
    logger: pluginLogger,
    recoverAccounts,
    scheduler: recoveryScheduler,
    enqueue: queue,
  });

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
    rebuild: () => queue(() => commitConfig(runtime, (manager.current() as Snapshot).config, 'catalog')),
  });
  if (runtime.startupDiagnosticRebuildPending) {
    runtime.startupDiagnosticRebuildPending = false;
    await queue(() => commitConfig(runtime, (manager.current() as Snapshot).config, 'credential-diagnostic'));
  } else replaceCatalogJobs(runtime, initial.catalogJobs);

  const requestLog = createRequestLogStore(dbHandle.db);
  const usageCapture = createUsageCapture();
  const requestRecorder = createRequestRecorder({ store: requestLog, logger });
  const logicalSessionStore = new LogicalSessionStore();

  const configStore = await startRecovery(runtime, {
    recoverAccounts,
    recoveryScheduler,
    reconciliationRetryMs: testHooks?.reconciliationRetryMs ?? RECOVERY_DRAIN_RETRY_MS,
  });

  const providerSummaries = createProviderSummaries(manager);

  const reload = (): Promise<ConfigReloadResult> => queue(() => reloadNow(runtime));
  const oauthLoginSessions = startLoginSessions(runtime, reload);
  const watcher =
    options.configPath !== undefined && options.watchConfig !== false
      ? watchConfigFile(options.configPath, reload)
      : undefined;
  return assembleServerState(runtime, {
    manager,
    dbHandle,
    configStore,
    events,
    logicalSessionStore,
    oauthQuota,
    oauthLoginSessions,
    providerSummaries,
    reload,
    requestLog,
    requestRecorder,
    usageCapture,
    watcher,
    closeRecovery: () => runtime.recovery?.close(),
  });
}

function openServerDb(options: ServerStateOptions): OpenDbHandle {
  if (options.dbHome !== undefined) return openDb({ home: options.dbHome });
  return options.configPath === undefined ? openDb() : openDb({ home: dirname(options.configPath) });
}

export type {
  ConfigReloadLog,
  ConfigReloadResult,
  ProviderSummaryOptions,
  ServerState,
  ServerStateOptions,
} from './types';

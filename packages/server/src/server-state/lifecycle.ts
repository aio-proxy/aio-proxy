import type {
  AtomicConfigFile,
  DiagnosticFactory,
  PendingAccountOperation,
  PluginLogSink,
  PluginRepository,
  Router,
} from '@aio-proxy/core';
import { parseRuntimeConfig } from '@aio-proxy/core';
import type { OpenDbHandle } from '@aio-proxy/core/db';
import type { Config } from '@aio-proxy/types';

import type { AccountRemovalCoordinator } from '../account-removal';
import type { CatalogScheduler } from '../catalog-scheduler';
import type { ConfigStore } from '../config-store';
import { createConfigStore } from '../config-store';
import type { DashboardEventHub } from '../dashboard-events';
import type { FifoQueue } from '../fifo-queue';
import type { LogicalSessionStore } from '../logical-session-store';
import type { OAuthLoginSessionManager } from '../oauth-login-session/manager';
import { createOAuthLoginSessionManager } from '../oauth-login-session/manager';
import type { SnapshotManager } from '../plugin-snapshot';
import { providerDiff } from '../provider-runtime';
import type { RetiredProviderSnapshot, RuntimeProviderInstance } from '../runtime';
import type { ServerLogSink } from '../server-log';
import { oauthCapabilities, oauthProviderEditView } from './oauth-views';
import { createRecovery } from './recovery';
import { reloadSnapshot } from './reload';
import { buildSnapshot, providerConfigRecord, type Snapshot } from './snapshot';
import type { ConfigReloadResult, InternalServerStateOptions, ServerState, ServerStateOptions } from './types';

export type ServerRuntime = {
  readonly options: ServerStateOptions;
  readonly internalOptions: InternalServerStateOptions;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly pluginLogger: PluginLogSink;
  readonly logger: ServerLogSink;
  readonly queue: FifoQueue;
  readonly events: DashboardEventHub;
  readonly createRouter: (providers: readonly RuntimeProviderInstance[]) => Router<RuntimeProviderInstance>;
  manager: SnapshotManager;
  managerReady: boolean;
  closed: boolean;
  startupDiagnosticRebuildPending: boolean;
  accountRemovals: AccountRemovalCoordinator;
  scheduler: CatalogScheduler;
  recovery: RecoveryHandle | undefined;
  configFile: AtomicConfigFile | undefined;
};

export function queueRebuild(runtime: ServerRuntime): void {
  if (runtime.closed) return;
  if (!runtime.managerReady) {
    runtime.startupDiagnosticRebuildPending = true;
    return;
  }
  void runtime
    .queue(async () => {
      if (!runtime.closed)
        await commitConfig(runtime, (runtime.manager.current() as Snapshot).config, 'credential-diagnostic');
    })
    .catch(() => {});
}

export function replaceCatalogJobs(runtime: ServerRuntime, jobs: Snapshot['catalogJobs']): void {
  runtime.scheduler.replaceJobs(jobs);
  runtime.internalOptions.__test?.onCatalogJobsReplaced?.(jobs);
}

export async function commitConfig(
  runtime: ServerRuntime,
  config: Config,
  _reason: string,
): Promise<RetiredProviderSnapshot> {
  const previous = runtime.manager.current() as Snapshot;
  const candidate = await buildSnapshot(
    config,
    previous,
    runtime.options,
    runtime.repository,
    runtime.diagnostics,
    runtime.pluginLogger,
    () => queueRebuild(runtime),
    runtime.createRouter,
  );
  const before = (runtime.manager.current() as Snapshot).summaries;
  const retired = runtime.manager.swap(candidate);
  replaceCatalogJobs(runtime, candidate.catalogJobs);
  runtime.events.publish({ event: 'config.changed', data: providerDiff(before, candidate.summaries) });
  runtime.accountRemovals.cancelReadded(providerConfigRecord(previous.config), providerConfigRecord(config));
  return retired;
}

export function reloadNow(
  runtime: ServerRuntime,
  retainedOperations: readonly PendingAccountOperation[] = [],
): Promise<ConfigReloadResult> {
  return reloadSnapshot({
    accountRemovals: runtime.accountRemovals,
    commitConfig: (config, reason) => commitConfig(runtime, config, reason),
    configFile: runtime.configFile,
    logger: runtime.logger,
    manager: runtime.manager,
    ...(runtime.internalOptions.__dashboardAuthHealthChanged === undefined
      ? {}
      : { onDashboardAuthHealthChanged: runtime.internalOptions.__dashboardAuthHealthChanged }),
    retainedOperations,
  });
}

export type ServerStateParts = Pick<
  ServerState,
  | 'configStore'
  | 'events'
  | 'logicalSessionStore'
  | 'oauthQuota'
  | 'oauthLoginSessions'
  | 'providerSummaries'
  | 'reload'
  | 'traceStore'
  | 'requestRecorder'
  | 'usageCapture'
> & {
  readonly manager: SnapshotManager;
  readonly dbHandle: OpenDbHandle;
  readonly configStore: ConfigStore;
  readonly oauthLoginSessions: OAuthLoginSessionManager;
  readonly logicalSessionStore: LogicalSessionStore;
  readonly watcher: { readonly close: () => void } | undefined;
  readonly closeRecovery: () => void;
};
export function assembleServerState(runtime: ServerRuntime, parts: ServerStateParts): ServerState {
  const { manager, dbHandle } = parts;
  const { events, repository, options, logger } = runtime;
  return {
    acquireProviderSnapshot: manager.acquire,
    close() {
      if (runtime.closed) return;
      runtime.closed = true;
      parts.watcher?.close();
      runtime.scheduler.close();
      parts.closeRecovery();
      parts.oauthLoginSessions.close();
      events.close();
      dbHandle.close();
    },
    configPath: options.configPath,
    configStore: parts.configStore,
    currentProviderSnapshot: manager.current,
    debugLogging: options.config.server.logging?.level === 'debug',
    events,
    logicalSessionStore: parts.logicalSessionStore,
    oauthCapabilities: () => oauthCapabilities(manager),
    oauthProviderEditView: (providerId) => oauthProviderEditView(manager, repository, providerId),
    oauthLoginSessions: parts.oauthLoginSessions,
    providerSummaries: parts.providerSummaries,
    currentConfig: () => (manager.current() as Snapshot).config,
    oauthQuota: parts.oauthQuota,
    reload: parts.reload,
    traceStore: parts.traceStore,
    logger,
    requestRecorder: parts.requestRecorder,
    usageCapture: parts.usageCapture,
  };
}

export type RecoveryHandle = {
  readonly start: () => Promise<void>;
  readonly schedule: (runAt: number) => void;
  readonly scheduleReconciliation: (operations: readonly PendingAccountOperation[]) => void;
  readonly close: () => void;
};

export async function startRecovery(
  runtime: ServerRuntime,
  deps: {
    readonly recoverAccounts: Parameters<typeof createRecovery>[0]['recoverAccounts'];
    readonly recoveryScheduler: Parameters<typeof createRecovery>[0]['scheduler'];
    readonly reconciliationRetryMs: number;
  },
): Promise<ConfigStore> {
  const recovery = createRecovery({
    configFile: runtime.configFile,
    repository: runtime.repository,
    diagnostics: runtime.diagnostics,
    logger: runtime.pluginLogger,
    recoverAccounts: deps.recoverAccounts,
    scheduler: deps.recoveryScheduler,
    reconciliationRetryMs: deps.reconciliationRetryMs,
    enqueue: runtime.queue,
    canDeleteAccount: runtime.manager.canDeleteAccount,
    reloadNow: (operations) => reloadNow(runtime, operations),
  });
  runtime.recovery = recovery;
  await recovery.start();
  return createConfigStore({
    getConfigPath: () => runtime.options.configPath,
    ...(runtime.configFile === undefined ? {} : { file: runtime.configFile }),
    accountRemovals: runtime.accountRemovals,
    enqueue: runtime.queue,
    onReconciliationNeeded: recovery.scheduleReconciliation,
    repository: runtime.repository,
    verify: (candidate) => commitConfig(runtime, parseRuntimeConfig(candidate), 'config-store'),
  });
}

export function startLoginSessions(
  runtime: ServerRuntime,
  reload: () => Promise<ConfigReloadResult>,
): OAuthLoginSessionManager {
  const { manager, repository, diagnostics, pluginLogger, internalOptions } = runtime;
  const testHooks = internalOptions.__test;
  return createOAuthLoginSessionManager({
    configFile: runtime.configFile,
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
    ...(testHooks?.oauthSessionNow === undefined ? {} : { now: testHooks.oauthSessionNow }),
    ...(testHooks?.oauthSessionTtlMs === undefined ? {} : { terminalSessionTtlMs: testHooks.oauthSessionTtlMs }),
  });
}

import type {
  AtomicConfigFile,
  DiagnosticFactory,
  PendingAccountOperation,
  PluginLogSink,
  PluginRepository,
} from '@aio-proxy/core';
import { createProxyFetch, OAuthCapabilityUnavailableError, parseRuntimeConfig } from '@aio-proxy/core';
import type { DatabaseOwnershipLock, OpenDbHandle } from '@aio-proxy/core/db';
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
import { findPluginEntry } from '../plugin-control-plane/plugin-config';
import { createRuntimeFetch } from '../plugin-runtime';
import type { SnapshotManager } from '../plugin-snapshot';
import { effectiveProxy, providerDiff } from '../provider-runtime';
import type { ProviderCooldownStore } from '../routes/pipeline/provider-cooldown';
import type { RetiredProviderSnapshot } from '../runtime';
import type { ServerLogSink } from '../server-log';
import { oauthCapabilities, oauthProviderEditView } from './oauth-views';
import { createRecovery } from './recovery';
import { reloadSnapshot } from './reload';
import { buildSnapshot, providerConfigRecord, type Snapshot } from './snapshot';
import type {
  ConfigReloadResult,
  CreateRouter,
  InternalServerStateOptions,
  ServerState,
  ServerStateOptions,
} from './types';

export type ServerRuntime = {
  readonly options: ServerStateOptions;
  readonly internalOptions: InternalServerStateOptions;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly pluginLogger: PluginLogSink;
  readonly logger: ServerLogSink;
  readonly queue: FifoQueue;
  readonly events: DashboardEventHub;
  readonly createRouter: CreateRouter;
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
  | 'agentIdentity'
  | 'configStore'
  | 'events'
  | 'logicalSessionStore'
  | 'oauthQuota'
  | 'oauthLoginSessions'
  | 'pluginControlPlane'
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
  readonly cooldown: ProviderCooldownStore;
  readonly watcher: { readonly close: () => void } | undefined;
  readonly closeRecovery: () => void;
  readonly databaseOwnership: DatabaseOwnershipLock;
};
export function assembleServerState(runtime: ServerRuntime, parts: ServerStateParts): ServerState {
  const { manager, dbHandle } = parts;
  const { events, repository, options, logger } = runtime;
  return {
    agentIdentity: parts.agentIdentity,
    acquireProviderSnapshot: manager.acquire,
    cooldown: parts.cooldown,
    close() {
      if (runtime.closed) return;
      runtime.closed = true;
      const failures: unknown[] = [];
      for (const close of [
        () => parts.watcher?.close(),
        () => runtime.scheduler.close(),
        parts.closeRecovery,
        () => parts.oauthLoginSessions.close(),
        () => events.close(),
        () => dbHandle.close(),
        parts.databaseOwnership.release,
      ]) {
        try {
          close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures[0] !== undefined) throw failures[0];
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
    pluginControlPlane: parts.pluginControlPlane,
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
  registerStartupCleanup: (cleanup: () => void) => void,
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
  registerStartupCleanup(() => recovery.close());
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
  configStore: ConfigStore,
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
    coordinateProviderCommit: (capability, commit) =>
      configStore.coordinateProviderMutation(() => {
        const registry = (manager.current() as Snapshot).plugins.registry;
        if (registry.resolveOAuth(capability.plugin, capability.capability) === undefined) {
          throw new OAuthCapabilityUnavailableError(capability.plugin, capability.capability);
        }
        return commit();
      }),
    validateProviderCommit: (capability, current) => {
      const plugins = (manager.current() as Snapshot).plugins;
      const builtIn = plugins.plugins.get(capability.plugin)?.builtIn === true;
      if (
        (!builtIn && findPluginEntry(current, capability.plugin) === undefined) ||
        plugins.registry.resolveOAuth(capability.plugin, capability.capability) === undefined
      ) {
        throw new OAuthCapabilityUnavailableError(capability.plugin, capability.capability);
      }
    },
    createFetch: (input) => {
      const config = (manager.current() as Snapshot).config;
      const configured = config.providers.find((provider) => provider.id === input.targetProviderId);
      const configuredProxy = configured?.kind === 'oauth' ? configured.proxy : undefined;
      const patchProxy = input.providerPatch?.proxy;
      const providerProxy = patchProxy === undefined ? configuredProxy : (patchProxy ?? undefined);
      const control = createProxyFetch(effectiveProxy(config.proxy, providerProxy), globalThis.fetch);
      return createRuntimeFetch({ control, model: control });
    },
    reload,
    ...(testHooks?.oauthSessionNow === undefined ? {} : { now: testHooks.oauthSessionNow }),
    ...(testHooks?.oauthSessionTtlMs === undefined ? {} : { terminalSessionTtlMs: testHooks.oauthSessionTtlMs }),
  });
}

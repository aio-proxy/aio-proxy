import { createHash } from 'node:crypto';

import {
  AtomicConfigFile,
  AtomicConfigExpectedDigestError,
  AtomicConfigLockReleaseError,
  createSyncRepository,
  encodeCandidate,
  parseRuntimeConfig,
  type PluginRegistrySnapshot,
  type PluginRepository,
  type JsonValue,
  type EntityBody,
  type PendingReason,
  type OAuthSharingService,
  type SharedOAuthCoordinator,
  type LocalBinding,
} from '@aio-proxy/core';
import type { OpenDbHandle } from '@aio-proxy/core/db';
import type { SyncSession } from '@aio-proxy/plugin-sdk';

import type { FifoQueue } from '../../fifo-queue';
import { createLocalSyncPort, createServerSyncLifecycle, SyncOperationError } from '../../sync-control-plane';
import { createSyncCommitHooks, type SyncCommitHooks } from '../../sync-control-plane/commit';
import type { PluginSecretChange } from '../../sync-control-plane/local-port';
import { commitConfig, type ServerRuntime } from '../lifecycle';
import { createActivationCheck } from '../sync-activation';
import type { ServerStateOptions } from '../types';
import { createConnectBackend, pruneBackendData, type SyncLifecycleSlot } from './connect-backend';

// eslint-disable-next-line max-lines-per-function -- lifecycle replacement keeps one integration owner
export function createSyncIntegration(
  runtime: ServerRuntime,
  dbHandle: OpenDbHandle,
  repository: PluginRepository,
  plugins: () => PluginRegistrySnapshot,
  configFile: AtomicConfigFile | undefined,
  options: ServerStateOptions,
  queue: FifoQueue,
  syncRepository = createSyncRepository(dbHandle.sqlite),
  onCoordinator?: (coordinator: SharedOAuthCoordinator | undefined) => void,
  onSharing?: (sharing: OAuthSharingService | undefined) => void,
) {
  if (configFile === undefined || options.configPath === undefined) {
    return {
      syncRepository,
      preparedCommits: new Map<string, SyncCommitHooks>(),
      syncBinding: null,
      syncPort: undefined,
      configFile: undefined,
      pluginVersions: () => new Map<string, string>(),
      syncApplyCandidate: async (
        _raw: Record<string, JsonValue>,
        _origin: 'local' | 'remote',
        _operationId?: string,
      ) => {},
      lifecycle: undefined,
      sharing: () => undefined,
      configPath: options.configPath,
      checkActivation: async (
        _raw: Record<string, JsonValue>,
        _body: EntityBody,
        _signal: AbortSignal,
        _intent?: 'reviewed',
      ): Promise<PendingReason | undefined> => undefined,
      connectBackend: async () => {
        throw new SyncOperationError('backend-unavailable');
      },
      onEngineStatus: (_handle: (status: string) => void) => {},
    };
  }
  const syncApplyCandidate = async (
    raw: Record<string, JsonValue>,
    origin: 'local' | 'remote',
    operationId?: string,
    _pluginSecret?: PluginSecretChange,
    expectedDigest?: string,
  ): Promise<void> => {
    const afterDigest = createHash('sha256').update(encodeCandidate(raw, options.configPath!)).digest('hex');
    try {
      await configFile.transaction(
        async (current) => {
          if (expectedDigest !== undefined) {
            const currentDigest = createHash('sha256')
              .update(encodeCandidate(current as Record<string, JsonValue>, options.configPath!))
              .digest('hex');
            if (currentDigest !== expectedDigest) throw new AtomicConfigExpectedDigestError();
          }
          if (origin === 'remote' && operationId !== undefined)
            runtime.remoteConfigFence = { digest: afterDigest, operationId };
          return { next: raw, result: undefined };
        },
        {
          ...(expectedDigest === undefined ? {} : { expectedDigest }),
          validateCandidate: (candidate) => void parseRuntimeConfig(candidate),
          verify: async (candidate) => {
            await commitConfig(
              runtime,
              parseRuntimeConfig(candidate),
              origin === 'remote' ? 'sync-remote' : 'sync-local',
            );
          },
        },
      );
    } catch (error) {
      if (
        !(error instanceof AtomicConfigLockReleaseError) &&
        !(error instanceof AtomicConfigExpectedDigestError) &&
        origin === 'remote' &&
        operationId !== undefined &&
        runtime.remoteConfigFence?.operationId === operationId
      )
        runtime.remoteConfigFence = undefined;
      throw error;
    }
  };
  const pluginVersions = () =>
    new Map(
      [...plugins().plugins]
        .filter(([, plugin]) => plugin.version !== undefined)
        .map(([name, plugin]) => [name, plugin.version!] as const),
    );
  const checkActivation = createActivationCheck({
    repo: syncRepository,
    accounts: repository,
    plugins,
    pluginVersions,
    sharing: () => sharing,
  });
  let sharing: OAuthSharingService | undefined;
  // One slot rather than two variables, because replacing the backend swaps the pair together and
  // has to be able to install or restore both from outside this closure.
  const active: SyncLifecycleSlot = { port: undefined, lifecycle: undefined };
  let engineStatus: ((status: string) => void) | undefined;
  let refreshCommitHooks: () => void = () => {};
  const onSharingChange = (next: OAuthSharingService | undefined): void => {
    sharing = next;
    onSharing?.(next);
  };

  const createLifecycle = (binding: LocalBinding | null, preconnectedSession?: SyncSession, candidate = false) => {
    const port =
      binding === null
        ? undefined
        : createLocalSyncPort({
            configPath: options.configPath!,
            configFile,
            repo: syncRepository,
            accounts: repository,
            bindingId: binding.id,
            bindingGeneration: binding.sessionGeneration,
            enqueue: queue,
            registry: () => plugins().registry,
            applyCandidate: syncApplyCandidate,
            checkActivation,
            pluginVersions,
          });
    let coordinator: SharedOAuthCoordinator | undefined;
    let nextSharing: OAuthSharingService | undefined;
    let nextLifecycle!: ReturnType<typeof createServerSyncLifecycle>;
    nextLifecycle = createServerSyncLifecycle({
      configPath: options.configPath!,
      configFile,
      repo: syncRepository,
      accounts: repository,
      registry: () => plugins().registry,
      enqueue: queue,
      applyCandidate: syncApplyCandidate,
      pluginVersions,
      localPort: port,
      onCoordinator: (next) => {
        coordinator = next;
        if (active.lifecycle === nextLifecycle) onCoordinator?.(next);
      },
      onSharing: (next) => {
        nextSharing = next;
        if (active.lifecycle === nextLifecycle) onSharingChange(next);
      },
      // A candidate lifecycle reconciles against a backend the user has not committed to yet, so
      // only the active one is allowed to move the publicly reported state.
      onStatus: (value) => {
        if (active.lifecycle === nextLifecycle) engineStatus?.(value);
      },
      withProviderGate: runtime.withProviderGate,
      // A candidate backend must not reconcile until replaceBackend has swapped it in and called
      // activate(). The lifecycle restored from a persisted binding has no such handover, so it
      // starts polling and watching immediately — otherwise a restart would never pick up remote
      // changes until the next local mutation or manual retry.
      deferEngine: candidate,
      ...(candidate && binding !== null ? { initialBinding: binding } : {}),
      ...(preconnectedSession === undefined ? {} : { preconnectedSession }),
    });
    return {
      port,
      lifecycle: nextLifecycle,
      publish() {
        onCoordinator?.(coordinator);
        onSharingChange(nextSharing);
      },
    };
  };

  const initial = createLifecycle(syncRepository.readBinding());
  active.port = initial.port;
  active.lifecycle = initial.lifecycle;

  const connectBackend = createConnectBackend({
    runtime,
    configFile,
    configPath: options.configPath,
    syncRepository,
    plugins,
    queue,
    active,
    createLifecycle,
    refreshCommitHooks: () => refreshCommitHooks(),
  });

  const integration = {
    syncRepository,
    // Confirmation is asynchronous, so a queued disconnect or backend replacement can land between
    // `prepare` and `confirm`. Rereading the binding would then look the intent up in the wrong
    // outbox (or none) and silently strand it, so each commit keeps the hooks it was prepared with.
    preparedCommits: new Map<string, SyncCommitHooks>(),
    get syncBinding() {
      return syncRepository.readBinding();
    },
    get syncPort() {
      return active.port;
    },
    configFile,
    pluginVersions,
    syncApplyCandidate,
    get lifecycle() {
      return active.lifecycle;
    },
    sharing: () => sharing,
    configPath: options.configPath,
    // Reconciliation reaches this through the port's `checkRemote`; a reviewed import has no port
    // yet on a first connect, and calls it directly.
    checkActivation,
    connectBackend,
    onEngineStatus(handle: (status: string) => void) {
      engineStatus = handle;
    },
  };
  refreshCommitHooks = () => {
    runtime.syncCommit = syncCommitOption(integration);
  };
  return integration;
}

export function syncCommitOption(integration: ReturnType<typeof createSyncIntegration>) {
  if (integration.configPath === undefined) return undefined;
  const confirmWith =
    (method: 'confirm' | 'confirmWithinFence') =>
    async (commitId: string): Promise<void> => {
      const hooks = integration.preparedCommits.get(commitId);
      // A commit prepared while sync was disabled has no hooks, and neither does one left over from
      // a previous process; both are the recovery pass's job, not this one's.
      if (hooks === undefined) return;
      try {
        await hooks[method](commitId);
      } finally {
        integration.preparedCommits.delete(commitId);
      }
    };
  return {
    prepare: (...args: Parameters<ReturnType<typeof createSyncCommitHooks>['prepare']>) => {
      const binding = integration.syncBinding;
      const port = integration.syncPort;
      if (binding === null || port === undefined) return `sync-disabled:${crypto.randomUUID()}`;
      const hooks = createSyncCommitHooks({
        path: integration.configPath!,
        repo: integration.syncRepository,
        bindingId: binding.id,
        port,
      });
      const commitId = hooks.prepare(...args);
      // A mutation that throws before confirming never reclaims its entry. Dropping the oldest past
      // this cap is safe: `recoverLocalCommits` owns any intent left prepared in the repository.
      // ponytail: fixed cap, swap for an explicit abandon hook if config writes ever fail in bulk.
      if (integration.preparedCommits.size >= 64) {
        const oldest = integration.preparedCommits.keys().next();
        if (!oldest.done) integration.preparedCommits.delete(oldest.value);
      }
      integration.preparedCommits.set(commitId, hooks);
      return commitId;
    },
    confirm: confirmWith('confirm'),
    confirmWithinFence: confirmWith('confirmWithinFence'),
  };
}

export async function startSyncIntegration(
  runtime: ServerRuntime,
  integration: ReturnType<typeof createSyncIntegration>,
  registerStartupCleanup: (cleanup: () => void | Promise<void>) => void,
): Promise<void> {
  if (integration.lifecycle === undefined) return;
  if (integration.configPath !== undefined) await pruneBackendData(integration.configPath, integration.syncBinding?.id);
  runtime.sync = integration.lifecycle;
  registerStartupCleanup(() => runtime.sync?.close());
  try {
    await integration.lifecycle.start();
  } catch (error) {
    await integration.lifecycle.close().catch(() => {});
    throw error;
  }
}

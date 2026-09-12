import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  AtomicConfigFile,
  AtomicConfigExpectedDigestError,
  AtomicConfigLockReleaseError,
  createSyncRepository,
  encodeCandidate,
  parseRuntimeConfig,
  seedAuthoredEntities,
  type PluginRegistrySnapshot,
  type PluginRepository,
  type JsonValue,
  type OAuthSharingService,
  type SharedOAuthCoordinator,
  type LocalBinding,
} from '@aio-proxy/core';
import type { OpenDbHandle } from '@aio-proxy/core/db';
import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { createFifoQueue, type FifoQueue } from '../../fifo-queue';
import {
  assertNoRetainedOAuth,
  createLocalSyncPort,
  createServerSyncLifecycle,
  listRemoteEntities,
  SyncOperationError,
  type SyncConnectCandidate,
} from '../../sync-control-plane';
import { createSyncCommitHooks } from '../../sync-control-plane/commit';
import type { PluginSecretChange } from '../../sync-control-plane/local-port';
import { commitConfig, type ServerRuntime } from '../lifecycle';
import { createActivationCheck } from '../sync-activation';
import type { ServerStateOptions } from '../types';

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
      syncBinding: null,
      syncPort: undefined,
      configFile: undefined,
      syncApplyCandidate: async (
        _raw: Record<string, JsonValue>,
        _origin: 'local' | 'remote',
        _operationId?: string,
      ) => {},
      lifecycle: undefined,
      sharing: () => undefined,
      configPath: options.configPath,
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
  let syncPort: ReturnType<typeof createLocalSyncPort> | undefined;
  let lifecycle: ReturnType<typeof createServerSyncLifecycle> | undefined;
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
        if (lifecycle === nextLifecycle) onCoordinator?.(next);
      },
      onSharing: (next) => {
        nextSharing = next;
        if (lifecycle === nextLifecycle) onSharingChange(next);
      },
      // A candidate lifecycle reconciles against a backend the user has not committed to yet, so
      // only the active one is allowed to move the publicly reported state.
      onStatus: (value) => {
        if (lifecycle === nextLifecycle) engineStatus?.(value);
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
  syncPort = initial.port;
  lifecycle = initial.lifecycle;

  const replaceBackend = async (binding: LocalBinding, preconnectedSession: SyncSession): Promise<() => void> => {
    let next: ReturnType<typeof createLifecycle> | undefined;
    try {
      next = createLifecycle(binding, preconnectedSession, true);
      await next.lifecycle.start();
      const authored = (await configFile.read()) as Record<string, JsonValue>;
      await queue(async () => {
        const previousBinding = syncRepository.readBinding();
        // Retiring a binding that still holds a shared OAuth credential strands it: ownership names
        // an account object in the old backend's space, so detaching can no longer target it, and
        // the Provider stays blocked on this and every later binding. Refuse before anything is
        // committed and let the user detach on the backend that owns the credential.
        if (previousBinding !== null) assertNoRetainedOAuth(syncRepository, previousBinding.id);
        // Ownership is scoped to the space that holds the account object, and the replacement backend
        // has none. Nothing survives the guard above except an already detached row, so carry the
        // configuration only and let the new binding establish its own ownership.
        const previousEntities = (previousBinding === null ? [] : syncRepository.entities(previousBinding.id)).map(
          ({ oauth, ...entity }) => (oauth === undefined ? entity : { ...entity, pendingReason: null }),
        );
        const previousLifecycle = lifecycle;
        const previousPort = syncPort;
        const previousRuntimeSync = runtime.sync;
        try {
          syncRepository.writeBinding(binding);
          if (syncRepository.putEntities !== undefined) syncRepository.putEntities(binding.id, previousEntities);
          else for (const entity of previousEntities) syncRepository.putEntity(binding.id, entity);
          // Carrying the previous binding's rows over covers a backend switch, but a first
          // connection has none. Without a row per authored object the new binding starts blind:
          // status lists no Provider and a join has nothing to select. Seeding is excluded-only,
          // so connecting still publishes nothing until the user joins.
          seedAuthoredEntities(syncRepository, binding.id, authored);
          syncPort = next!.port;
          lifecycle = next!.lifecycle;
          runtime.sync = lifecycle;
          next!.publish();
          await previousLifecycle?.close().catch(() => {});
        } catch (error) {
          syncPort = previousPort;
          lifecycle = previousLifecycle;
          runtime.sync = previousRuntimeSync;
          if (syncRepository.readBinding()?.id === binding.id) {
            if (previousBinding === null) syncRepository.clearBinding?.();
            else syncRepository.writeBinding(previousBinding);
          }
          await next!.lifecycle.close().catch(() => {});
          throw error;
        }
      });
      // The engine stays deferred until the caller has applied the reviewed connect decisions:
      // reconciling first would import the candidate's remote objects under the engine's default
      // inclusion, transiently activating a cloud configuration the user chose to overwrite.
      const activate = next.lifecycle.activate;
      return activate;
    } catch (error) {
      if (next === undefined) await preconnectedSession.dispose().catch(() => {});
      else await next.lifecycle.close().catch(() => {});
      throw error;
    }
  };

  // Candidate startup uses the mutation queue for local recovery, so serialize whole connect operations here and
  // keep the existing queue available for the recovery and transactional swap steps.
  const connectQueue = createFifoQueue();
  const connectBackend = (input: {
    plugin: string;
    capability: string;
    options: JsonValue;
  }): Promise<SyncConnectCandidate> =>
    connectQueue(async () => {
      const backend = plugins().registry.resolveSync(input.plugin, input.capability);
      const parsed = backend?.options.schema.safeParse(input.options);
      if (backend === undefined || parsed === undefined || !parsed.success)
        throw new SyncOperationError('backend-unavailable');
      const normalizedOptions = parsed.data as JsonValue;
      const bindingId = `sync-${crypto.randomUUID()}`;
      const dataDirectory = join(dirname(options.configPath!), '.sync', bindingId);
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await chmod(dataDirectory, 0o700);
      // The candidate owns its backend work until `commit()` hands the session to a lifecycle: a
      // stalled `connect`/`list` would otherwise sit in `connectQueue` forever and block every later
      // connection attempt, and the per-attempt directory would pile up once the preview is dropped.
      const lifetime = new AbortController();
      const discard = async (): Promise<void> => {
        lifetime.abort();
        await rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
      };
      let session: SyncSession | undefined;
      try {
        session = await backend.connect(normalizedOptions, { signal: lifetime.signal, dataDirectory });
        if (session.spaceId !== 'default') throw new SyncOperationError('backend-unavailable');
        const current = syncRepository.readBinding();
        const candidateSession = session;
        // Read the candidate's cloud state before it is bound: this is the snapshot the preview
        // reviews, and reconciliation must not be the first thing that sees these objects.
        const remote = await listRemoteEntities(candidateSession, lifetime.signal);
        session = undefined;
        const binding: LocalBinding = {
          id: bindingId,
          plugin: input.plugin,
          capability: input.capability,
          pluginVersion: plugins().plugins.get(input.plugin)?.version ?? 'unknown',
          identityId: candidateSession.identityId,
          spaceId: 'default',
          deviceId: current?.deviceId ?? crypto.randomUUID(),
          sessionGeneration: (current?.sessionGeneration ?? 0) + 1,
          options: normalizedOptions,
        };
        let released = false;
        let activateBackend: (() => void) | undefined;
        return {
          remote,
          refresh: () => listRemoteEntities(candidateSession, lifetime.signal),
          commit: () =>
            connectQueue(async () => {
              // replaceBackend takes over the session either way: on success the new lifecycle owns
              // it, and on failure it disposes the session or closes the lifecycle holding it. The
              // caller still disposes the candidate when applying fails, which would otherwise
              // either double-dispose or tear down the session that is now live.
              released = true;
              try {
                activateBackend = await replaceBackend(binding, candidateSession);
                refreshCommitHooks();
              } catch (error) {
                await discard();
                if (error instanceof SyncOperationError) throw error;
                throw new SyncOperationError('backend-unavailable');
              }
            }),
          activate: () => activateBackend?.(),
          dispose: async () => {
            if (released) return;
            released = true;
            await candidateSession.dispose().catch(() => {});
            await discard();
          },
        };
      } catch (error) {
        await session?.dispose().catch(() => {});
        await discard();
        if (error instanceof SyncOperationError) throw error;
        throw new SyncOperationError('backend-unavailable');
      }
    });

  const integration = {
    syncRepository,
    get syncBinding() {
      return syncRepository.readBinding();
    },
    get syncPort() {
      return syncPort;
    },
    configFile,
    syncApplyCandidate,
    get lifecycle() {
      return lifecycle;
    },
    sharing: () => sharing,
    configPath: options.configPath,
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
  return {
    prepare: (...args: Parameters<ReturnType<typeof createSyncCommitHooks>['prepare']>) => {
      const binding = integration.syncBinding;
      const port = integration.syncPort;
      if (binding === null || port === undefined) return `sync-disabled:${crypto.randomUUID()}`;
      return createSyncCommitHooks({
        path: integration.configPath!,
        repo: integration.syncRepository,
        bindingId: binding.id,
        port,
      }).prepare(...args);
    },
    confirm: (commitId: string) => {
      const binding = integration.syncBinding;
      const port = integration.syncPort;
      if (binding === null || port === undefined) return Promise.resolve();
      return createSyncCommitHooks({
        path: integration.configPath!,
        repo: integration.syncRepository,
        bindingId: binding.id,
        port,
      }).confirm(commitId);
    },
  };
}

export async function startSyncIntegration(
  runtime: ServerRuntime,
  integration: ReturnType<typeof createSyncIntegration>,
  registerStartupCleanup: (cleanup: () => void | Promise<void>) => void,
): Promise<void> {
  if (integration.lifecycle === undefined) return;
  runtime.sync = integration.lifecycle;
  registerStartupCleanup(() => runtime.sync?.close());
  try {
    await integration.lifecycle.start();
  } catch (error) {
    await integration.lifecycle.close().catch(() => {});
    throw error;
  }
}

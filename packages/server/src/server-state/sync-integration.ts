import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  AtomicConfigFile,
  AtomicConfigExpectedDigestError,
  AtomicConfigLockReleaseError,
  createSyncRepository,
  encodeCandidate,
  parseRuntimeConfig,
  parsePluginSchema,
  type PluginRegistrySnapshot,
  type PluginRepository,
  type JsonValue,
  type OAuthSharingService,
  type SharedOAuthCoordinator,
  type EntityBody,
  type LocalBinding,
  type LocalOverride,
  type LocalEntity,
} from '@aio-proxy/core';
import type { OpenDbHandle } from '@aio-proxy/core/db';
import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { createFifoQueue, type FifoQueue } from '../fifo-queue';
import type { OAuthLoginSessionManager } from '../oauth-login-session/manager';
import {
  checkPrerequisites,
  createLocalSyncPort,
  createServerSyncLifecycle,
  createSyncControlPlane,
  readOAuthActivationEvidence,
  SyncOperationError,
  type OAuthActivationEvidence,
} from '../sync-control-plane';
import { createSyncCommitHooks } from '../sync-control-plane/commit';
import type { PluginSecretChange } from '../sync-control-plane/local-port';
import { commitConfig, type ServerRuntime } from './lifecycle';
import type { ServerStateOptions } from './types';

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
      syncApplyCandidate: async () => {},
      lifecycle: undefined,
      sharing: () => undefined,
      configPath: options.configPath,
      connectBackend: async () => {
        throw new SyncOperationError('backend-unavailable');
      },
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
  const checkActivation = async (raw: Record<string, JsonValue>, body: import('@aio-proxy/core').EntityBody) => {
    let credentialValid = true;
    let oauthEvidence: OAuthActivationEvidence | undefined;
    const currentBinding = syncRepository.readBinding();
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
          : plugins().registry.resolveOAuth(plugin, capability);
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
          currentBinding === null
            ? undefined
            : syncRepository.entities(currentBinding.id).find((entity) => entity.logicalKey === body.logicalKey),
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
  let sharing: OAuthSharingService | undefined;
  let syncPort: ReturnType<typeof createLocalSyncPort> | undefined;
  let lifecycle: ReturnType<typeof createServerSyncLifecycle> | undefined;
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
      withProviderGate: runtime.withProviderGate,
      deferEngine: true,
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

  const replaceBackend = async (binding: LocalBinding, preconnectedSession: SyncSession): Promise<void> => {
    let next: ReturnType<typeof createLifecycle> | undefined;
    try {
      next = createLifecycle(binding, preconnectedSession, true);
      await next.lifecycle.start();
      await queue(async () => {
        const previousBinding = syncRepository.readBinding();
        const previousEntities = previousBinding === null ? [] : syncRepository.entities(previousBinding.id);
        const previousLifecycle = lifecycle;
        const previousPort = syncPort;
        const previousRuntimeSync = runtime.sync;
        try {
          syncRepository.writeBinding(binding);
          if (syncRepository.putEntities !== undefined) syncRepository.putEntities(binding.id, previousEntities);
          else for (const entity of previousEntities) syncRepository.putEntity(binding.id, entity);
          next!.lifecycle.activate();
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
    } catch (error) {
      if (next === undefined) await preconnectedSession.dispose().catch(() => {});
      else await next.lifecycle.close().catch(() => {});
      throw error;
    }
  };

  // Candidate startup uses the mutation queue for local recovery, so serialize whole connect operations here and
  // keep the existing queue available for the recovery and transactional swap steps.
  const connectQueue = createFifoQueue();
  const connectBackend = (input: { plugin: string; capability: string; options: JsonValue }): Promise<void> =>
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
      let session: SyncSession | undefined;
      try {
        session = await backend.connect(normalizedOptions, { signal: new AbortController().signal, dataDirectory });
        if (session.spaceId !== 'default') throw new SyncOperationError('backend-unavailable');
        const current = syncRepository.readBinding();
        const candidateSession = session;
        session = undefined;
        await replaceBackend(
          {
            id: bindingId,
            plugin: input.plugin,
            capability: input.capability,
            pluginVersion: plugins().plugins.get(input.plugin)?.version ?? 'unknown',
            identityId: candidateSession.identityId,
            spaceId: 'default',
            deviceId: current?.deviceId ?? crypto.randomUUID(),
            sessionGeneration: (current?.sessionGeneration ?? 0) + 1,
            options: normalizedOptions,
          },
          candidateSession,
        );
        refreshCommitHooks();
      } catch (error) {
        await session?.dispose().catch(() => {});
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
    syncApplyCandidate,
    get lifecycle() {
      return lifecycle;
    },
    sharing: () => sharing,
    configPath: options.configPath,
    connectBackend,
  };
  refreshCommitHooks = () => {
    runtime.syncCommit = syncCommitOption(integration);
  };
  return integration;
}

function localOverrideValue(body: EntityBody | null | undefined, path: readonly string[]): JsonValue | undefined {
  let value: JsonValue | undefined = body?.value;
  for (const segment of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, JsonValue>)[segment];
  }
  return value;
}

function accountCandidate(account: NonNullable<ReturnType<PluginRepository['readAccount']>>) {
  return {
    providerId: account.providerId,
    plugin: account.plugin,
    capability: account.capability,
    fingerprint: account.fingerprint,
    options: account.options,
    secrets: account.secrets,
    credential: account.credential,
    ...(account.label === undefined ? {} : { label: account.label }),
    ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
    catalog: { kind: 'preserve' as const },
  };
}

export function createSyncControlPlaneIntegration(
  runtime: ServerRuntime,
  integration: ReturnType<typeof createSyncIntegration>,
  oauthLoginSessions: OAuthLoginSessionManager,
) {
  if (integration.configPath === undefined) return undefined;
  return createSyncControlPlane({
    repo: integration.syncRepository,
    registry: () => (runtime.manager.current() as import('./snapshot').Snapshot).plugins.registry,
    accounts: runtime.repository,
    backendOptions: (plugin, capability) => {
      const binding = integration.syncRepository.readBinding();
      return binding?.plugin === plugin && binding.capability === capability ? binding.options : undefined;
    },
    binding: () => integration.syncRepository.readBinding(),
    localEntities: () => {
      const binding = integration.syncRepository.readBinding();
      return binding === null ? [] : integration.syncRepository.entities(binding.id);
    },
    session: () => integration.lifecycle?.session(),
    lifecycle: {
      activate: () => integration.lifecycle?.activate(),
      reconcile: () => integration.lifecycle?.reconcile() ?? Promise.resolve(),
      close: async () => integration.lifecycle?.close(),
    },
    applyLocal: async (candidate, _current, objectId) => {
      const syncPort = integration.syncPort;
      if (syncPort === undefined) throw new SyncOperationError('not-connected');
      const result = await syncPort.applyRemote(objectId, candidate, `control:${crypto.randomUUID()}`);
      if (!result.applied) throw new SyncOperationError('operation-pending');
    },
    persistOverrides: async (objectId, paths, current) => {
      const binding = integration.syncRepository.readBinding();
      if (binding === null || current === undefined || current.objectId !== objectId)
        throw new SyncOperationError('not-connected');
      const selected = new Set(paths.map((path) => JSON.stringify(path)));
      const overrides: LocalOverride[] = [
        ...current.overrides.filter((override) => !selected.has(JSON.stringify(override.path))),
        ...paths.map((path) => {
          const value = localOverrideValue(current.desired, path);
          return { path: [...path], value };
        }),
      ];
      integration.syncRepository.putEntity(binding.id, { ...current, overrides });
    },
    connect: integration.connectBackend,
    detach: async (providerId, loginSessionId) => {
      const session = oauthLoginSessions.get(loginSessionId);
      if (session?.status !== 'succeeded' || session.providerId !== providerId)
        throw new SyncOperationError('operation-pending');
      const sharing = integration.sharing();
      const account = runtime.repository.readAccount(providerId);
      if (sharing === undefined || account === null) throw new SyncOperationError('backend-unavailable');
      await sharing.detach(providerId, accountCandidate(account), new AbortController().signal);
    },
    cancelDetach: async (providerId) => {
      const sharing = integration.sharing();
      if (sharing === undefined) throw new SyncOperationError('backend-unavailable');
      sharing.cancelDetach(providerId);
    },
    persistProviderIdentity: async (_oldProviderId, _newProviderId, entities: readonly LocalEntity[]) => {
      const binding = integration.syncRepository.readBinding();
      if (binding === null || integration.syncRepository.putEntities === undefined)
        throw new SyncOperationError('upgrade-required');
      integration.syncRepository.putEntities(binding.id, entities);
    },
  });
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

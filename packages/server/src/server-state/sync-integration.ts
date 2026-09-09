import {
  AtomicConfigFile,
  createSyncRepository,
  parseRuntimeConfig,
  parsePluginSchema,
  type PluginRegistrySnapshot,
  type PluginRepository,
  type JsonValue,
  type OAuthSharingService,
  type SharedOAuthCoordinator,
  type EntityBody,
  type LocalOverride,
  type LocalEntity,
} from '@aio-proxy/core';
import type { OpenDbHandle } from '@aio-proxy/core/db';

import type { createFifoQueue } from '../fifo-queue';
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
import { commitConfig, type ServerRuntime } from './lifecycle';
import type { ServerStateOptions } from './types';

export function createSyncIntegration(
  runtime: ServerRuntime,
  dbHandle: OpenDbHandle,
  repository: PluginRepository,
  plugins: () => PluginRegistrySnapshot,
  configFile: AtomicConfigFile | undefined,
  options: ServerStateOptions,
  queue: ReturnType<typeof createFifoQueue>,
  syncRepository = createSyncRepository(dbHandle.sqlite),
  onCoordinator?: (coordinator: SharedOAuthCoordinator | undefined) => void,
  onSharing?: (sharing: OAuthSharingService | undefined) => void,
) {
  const syncBinding = syncRepository.readBinding();
  if (syncBinding === null || configFile === undefined || options.configPath === undefined) {
    return {
      syncRepository,
      syncBinding,
      syncPort: undefined,
      syncApplyCandidate: async () => {},
      lifecycle: undefined,
      sharing: () => undefined,
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
      [...plugins().plugins]
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
          syncRepository.entities(syncBinding.id).find((entity) => entity.logicalKey === body.logicalKey),
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
    registry: () => plugins().registry,
    applyCandidate: syncApplyCandidate,
    checkActivation,
    pluginVersions,
  });
  let sharing: OAuthSharingService | undefined;
  const onSharingChange = (next: OAuthSharingService | undefined): void => {
    sharing = next;
    onSharing?.(next);
  };
  const lifecycleWithSharing = createServerSyncLifecycle({
    configPath: options.configPath,
    configFile,
    repo: syncRepository,
    accounts: repository,
    registry: () => plugins().registry,
    enqueue: queue,
    applyCandidate: syncApplyCandidate,
    pluginVersions,
    localPort: syncPort,
    onCoordinator,
    onSharing: onSharingChange,
    withProviderGate: runtime.withProviderGate,
    deferEngine: true,
  });
  return {
    syncRepository,
    syncBinding,
    syncPort,
    syncApplyCandidate,
    lifecycle: lifecycleWithSharing,
    sharing: () => sharing,
    configPath: options.configPath,
  };
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
  if (
    integration.lifecycle === undefined ||
    integration.syncPort === undefined ||
    integration.syncBinding === null ||
    integration.configPath === undefined
  )
    return undefined;
  const lifecycle = integration.lifecycle;
  const syncPort = integration.syncPort;
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
    session: lifecycle.session,
    lifecycle,
    applyLocal: async (candidate, _current, objectId) => {
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
    connect: async () => {
      throw new SyncOperationError('backend-unavailable');
    },
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
  return integration.syncBinding === null || integration.syncPort === undefined
    ? undefined
    : createSyncCommitHooks({
        path: integration.configPath,
        repo: integration.syncRepository,
        bindingId: integration.syncBinding.id,
        port: integration.syncPort,
      });
}

export async function startSyncIntegration(
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

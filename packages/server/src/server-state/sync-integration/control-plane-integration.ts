import type { EntityBody, JsonValue, LocalEntity, LocalOverride, PluginRepository } from '@aio-proxy/core';

import type { OAuthLoginSessionManager } from '../../oauth-login-session/manager';
import { createSyncControlPlane, SyncOperationError } from '../../sync-control-plane';
import type { ServerRuntime } from '../lifecycle';
import { renameProviderIdentity } from '../sync-rename';
import type { createSyncIntegration } from './sync-integration';

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
    registry: () => (runtime.manager.current() as import('../snapshot').Snapshot).plugins.registry,
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
    withFence: async (run) => {
      const syncPort = integration.syncPort;
      return syncPort === undefined ? run() : syncPort.withFence(run);
    },
    onEngineStatus: integration.onEngineStatus,
    committedSource: async () => {
      const syncPort = integration.syncPort;
      if (syncPort === undefined) throw new SyncOperationError('not-connected');
      return syncPort.committedSource();
    },
    lifecycle: {
      start: async () => integration.lifecycle?.start(),
      activate: () => integration.lifecycle?.activate(),
      reconcile: () => integration.lifecycle?.reconcile() ?? Promise.resolve(),
      close: async () => integration.lifecycle?.close(),
    },
    applyLocal: async (candidate, _current, objectId) => {
      const syncPort = integration.syncPort;
      if (syncPort === undefined) throw new SyncOperationError('not-connected');
      // `reviewed`: the row is still excluded while a join's import writes — its inclusion is
      // recorded right after this call — so the port must not read that as a Leave to respect.
      const result = await syncPort.applyRemote(objectId, candidate, `control:${crypto.randomUUID()}`, 'reviewed');
      if (!result.applied) throw new SyncOperationError('operation-pending');
    },
    persistOverrides: async (objectId, paths, current, authored) => {
      const binding = integration.syncRepository.readBinding();
      if (binding === null || current === undefined || current.objectId !== objectId)
        throw new SyncOperationError('not-connected');
      // `paths` is the reviewed resulting set, so it replaces the stored overrides instead of
      // unioning with them: removing the last pinned path has to unmask the cloud value. The value
      // comes from the authored configuration the preview projected, not the published body: a
      // local-only object has none, and `undefined` here deletes the very setting the pin was meant
      // to keep.
      const overrides: LocalOverride[] = paths.map((path) => ({
        path: [...path],
        value: localOverrideValue(authored, path),
      }));
      integration.syncRepository.putEntity(binding.id, { ...current, overrides });
    },
    shareOAuth: async (providerId) => {
      const lifecycle = integration.lifecycle;
      if (lifecycle === undefined) return;
      // Bound to the lifecycle that owns the sharing service, so a stalled backend read cannot keep
      // holding the Provider gate after a disconnect, a backend swap, or shutdown. 'pending' is
      // journalled by the sharing service and finished by its recovery pass, so the published
      // configuration is not rolled back for it.
      await integration.sharing()?.share(providerId, lifecycle.signal);
    },
    connect: integration.connectBackend,
    detach: async (providerId, loginSessionId) => {
      const session = oauthLoginSessions.get(loginSessionId);
      if (session?.status !== 'succeeded' || session.providerId !== providerId)
        throw new SyncOperationError('operation-pending');
      const sharing = integration.sharing();
      const account = runtime.repository.readAccount(providerId);
      const lifecycle = integration.lifecycle;
      if (sharing === undefined || account === null || lifecycle === undefined)
        throw new SyncOperationError('backend-unavailable');
      await sharing.detach(providerId, accountCandidate(account), lifecycle.signal);
    },
    cancelDetach: async (providerId) => {
      const sharing = integration.sharing();
      if (sharing === undefined) throw new SyncOperationError('backend-unavailable');
      sharing.cancelDetach(providerId);
    },
    persistProviderIdentity: (oldProviderId, newProviderId, entities: readonly LocalEntity[]) =>
      renameProviderIdentity(
        {
          configFile: integration.configFile!,
          repo: integration.syncRepository,
          applyCandidate: integration.syncApplyCandidate,
        },
        oldProviderId,
        newProviderId,
        entities,
      ),
  });
}

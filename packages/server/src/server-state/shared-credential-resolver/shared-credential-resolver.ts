import {
  createSharedCredentialPort,
  type CredentialPortCallbacks,
  retainsSharedOAuth,
  SyncOAuthError,
  type PluginRepository,
  type SharedOAuthCoordinator,
  type SyncRepository,
} from '@aio-proxy/core';
import type { CredentialPort, OAuthAdapter, ZodType } from '@aio-proxy/plugin-sdk';

function blocked(code: ConstructorParameters<typeof SyncOAuthError>[0], message: string): CredentialPort<unknown> {
  return {
    read: async () => {
      throw new SyncOAuthError(code, message);
    },
    refresh: async () => {
      throw new SyncOAuthError(code, message);
    },
  };
}

export function createSharedCredentialResolver(
  syncRepository: SyncRepository,
  accounts: PluginRepository,
  coordinator: () => SharedOAuthCoordinator | undefined,
  resolveAdapter?: (providerId: string) => { adapter: OAuthAdapter; pluginVersion: string } | undefined,
): (
  providerId: string,
  schema: ZodType<unknown>,
  callbacks?: CredentialPortCallbacks,
) => CredentialPort<unknown> | undefined {
  function resolve(
    providerId: string,
    schema: ZodType<unknown>,
    callbacks?: CredentialPortCallbacks,
  ): CredentialPort<unknown> | undefined {
    const binding = syncRepository.readBinding();
    const owned = syncRepository.bindings().flatMap((entry) =>
      syncRepository
        .entities(entry.id)
        .filter((entity) => entity.kind === 'provider' && entity.logicalKey === providerId)
        .map((entity) => ({ bindingId: entry.id, entity })),
    );
    if (
      owned.some(
        ({ bindingId, entity }) =>
          bindingId !== binding?.id && retainsSharedOAuth(entity, syncRepository.oauthJournals(bindingId)),
      )
    ) {
      return blocked('detach-pending', 'The shared OAuth ownership is unresolved across synchronization bindings');
    }
    const entity = owned.find((entry) => entry.bindingId === binding?.id)?.entity;
    const hasJournal =
      binding !== null &&
      entity !== undefined &&
      syncRepository.oauthJournals(binding.id).some((row) => row.objectId === entity.objectId);
    if (entity?.oauth === undefined && hasJournal)
      return blocked('result-uncertain', 'The shared OAuth ownership is unresolved');
    if (binding === null || entity === undefined || entity.oauth === undefined || entity.oauth.mode === 'independent')
      return undefined;
    if (entity.oauth.mode !== 'shared') return blocked('detach-pending', 'The shared OAuth ownership is unresolved');
    const resolved = resolveAdapter?.(providerId);
    const sync = resolved?.adapter.credentialSync;
    if (
      resolved === undefined ||
      sync === undefined ||
      resolved.pluginVersion !== entity.oauth.pluginVersion ||
      sync.formatVersion !== entity.oauth.formatVersion ||
      !sync.multiDevice?.evidenceId ||
      sync.multiDevice.evidenceId !== entity.oauth.multiDeviceEvidenceId
    ) {
      syncRepository.putEntity(binding.id, { ...entity, pendingReason: 'pending-plugin-update' });
      return blocked('upgrade-required', 'The shared OAuth adapter requires compatible synchronization evidence');
    }
    const shared = coordinator();
    if (shared === undefined) return blocked('refresh-deferred', 'The shared OAuth coordinator is unavailable');
    return createSharedCredentialPort({
      providerId,
      objectId: entity.objectId,
      binding,
      coordinator: shared,
      repo: syncRepository,
      accounts,
      schema: resolved.adapter.credentials,
      ...callbacks,
    });
  }
  return (providerId, schema, callbacks) => {
    // The credential port re-runs this resolver on every read, so it also runs after the server
    // that owns the repository is closed. A repository this device cannot read says nothing about
    // ownership, and answering `undefined` would hand the Provider to the local refresh path — one
    // that rotates the credential alone while other devices still follow the shared account.
    const attempt = (): CredentialPort<unknown> | undefined | 'unreadable' => {
      try {
        return resolve(providerId, schema, callbacks);
      } catch {
        return 'unreadable';
      }
    };
    const unreadable = () => blocked('result-uncertain', 'The shared OAuth ownership could not be read');
    const first = attempt();
    if (first === undefined) return undefined;
    if (first === 'unreadable') return unreadable();
    // Ports can outlive a plugin reload, binding switch or ownership transition.
    const current = () => {
      const port = attempt();
      if (port === 'unreadable') return unreadable();
      return port ?? blocked('detach-pending', 'The shared OAuth ownership changed');
    };
    return { read: () => current().read(), refresh: (revision, exchange) => current().refresh(revision, exchange) };
  };
}

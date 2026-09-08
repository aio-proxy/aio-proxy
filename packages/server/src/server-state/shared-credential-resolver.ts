import {
  createSharedCredentialPort,
  type CredentialPortCallbacks,
  SyncOAuthError,
  type PluginRepository,
  type SharedOAuthCoordinator,
  type SyncRepository,
} from '@aio-proxy/core';
import type { CredentialPort, ZodType } from '@aio-proxy/plugin-sdk';

export function createSharedCredentialResolver(
  syncRepository: SyncRepository,
  accounts: PluginRepository,
  coordinator: () => SharedOAuthCoordinator | undefined,
): (
  providerId: string,
  schema: ZodType<unknown>,
  callbacks?: CredentialPortCallbacks,
) => CredentialPort<unknown> | undefined {
  return (providerId, schema, callbacks) => {
    const binding = syncRepository.readBinding();
    if (binding === null) return undefined;
    const entity = syncRepository.entities(binding.id).find((candidate) => candidate.logicalKey === providerId);
    if (entity === undefined || entity.oauth === undefined || entity.oauth.mode === 'independent') return undefined;
    if (entity.oauth.mode === 'detach-pending') {
      return {
        read: async () => {
          throw new SyncOAuthError('detach-pending', 'The shared OAuth ownership is unresolved');
        },
        refresh: async () => {
          throw new SyncOAuthError('detach-pending', 'The shared OAuth ownership is unresolved');
        },
      };
    }
    const shared = coordinator();
    if (shared === undefined) {
      return {
        read: async () => {
          throw new SyncOAuthError('refresh-deferred', 'The shared OAuth coordinator is unavailable');
        },
        refresh: async () => {
          throw new SyncOAuthError('refresh-deferred', 'The shared OAuth coordinator is unavailable');
        },
      };
    }
    return createSharedCredentialPort({
      providerId,
      objectId: entity.objectId,
      binding,
      coordinator: shared,
      repo: syncRepository,
      accounts,
      schema,
      ...callbacks,
    });
  };
}

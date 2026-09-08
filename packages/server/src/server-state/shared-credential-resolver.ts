import {
  createSharedCredentialPort,
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
): (providerId: string, schema: ZodType<unknown>) => CredentialPort<unknown> | undefined {
  return (providerId, schema) => {
    const binding = syncRepository.readBinding();
    if (binding === null) return undefined;
    const entity = syncRepository.entities(binding.id).find((candidate) => candidate.logicalKey === providerId);
    if (entity === undefined || entity.oauth === undefined || entity.oauth.mode === 'independent') return undefined;
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
    });
  };
}

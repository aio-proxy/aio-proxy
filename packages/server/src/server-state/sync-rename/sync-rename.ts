import type { AtomicConfigFile, LocalEntity, PluginRepository, SyncRepository } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';

import { rewireProviderReferences, SyncOperationError } from '../../sync-control-plane';

export type RenameProviderIdentityInput = {
  readonly configFile: AtomicConfigFile;
  readonly repo: SyncRepository;
  readonly accounts: Pick<PluginRepository, 'withAccountTransaction' | 'readAccount' | 'renameAccount'>;
  readonly applyCandidate: (
    raw: Record<string, JsonValue>,
    origin: 'local' | 'remote',
    operationId?: string,
  ) => Promise<void>;
};

/**
 * Lands the local half of a Provider rename. The `sync_entity` rows alone are not the rename:
 * leaving `providers[oldProviderId]` and the rules pointing at it in the authored configuration
 * makes the next projection miss the renamed included row, so it would publish that row's deletion
 * and reseed the old ID as excluded. The authored configuration is rewritten first, as a
 * remote-origin commit so it enqueues no publication of its own — the cloud half of the rename
 * belongs to `applyPreview`.
 */
export async function renameProviderIdentity(
  input: RenameProviderIdentityInput,
  oldProviderId: string,
  newProviderId: string,
  entities: readonly LocalEntity[],
): Promise<void> {
  const binding = input.repo.readBinding();
  const putEntities = input.repo.putEntities;
  if (binding === null || putEntities === undefined) throw new SyncOperationError('upgrade-required');
  // An authorized Provider keeps its credential under its Provider ID, so the account has to move
  // with the identity: the renamed Provider would otherwise read as unauthorized while the old
  // credential is orphaned, and sharing cannot repair that because there is no account left to
  // publish under the new ID.
  const moves = input.accounts.readAccount(oldProviderId) !== null;
  if (moves && input.accounts.readAccount(newProviderId) !== null) throw new SyncOperationError('upgrade-required');
  const authored = (await input.configFile.read()) as Record<string, JsonValue>;
  const renamed = rewireProviderReferences(authored, oldProviderId, newProviderId);
  await input.applyCandidate(renamed, 'remote', `rename:${crypto.randomUUID()}`);
  // One transaction: rows naming the new ID with the credential still under the old one is exactly
  // the unauthorized state this move exists to prevent.
  input.accounts.withAccountTransaction(() => {
    if (moves && !input.accounts.renameAccount(oldProviderId, newProviderId))
      throw new SyncOperationError('operation-pending');
    putEntities(binding.id, entities);
  });
}

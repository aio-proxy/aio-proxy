import type { AtomicConfigFile, LocalEntity, SyncRepository } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isRecord } from '@aio-proxy/shared';

import { rewireProviderReferences, SyncOperationError } from '../../sync-control-plane';

export type RenameProviderIdentityInput = {
  readonly configFile: AtomicConfigFile;
  readonly repo: SyncRepository;
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
  if (binding === null || input.repo.putEntities === undefined) throw new SyncOperationError('upgrade-required');
  const authored = (await input.configFile.read()) as Record<string, JsonValue>;
  const renamed = rewireProviderReferences(authored, oldProviderId, newProviderId);
  if (!isRecord(renamed)) throw new SyncOperationError('upgrade-required');
  await input.applyCandidate(renamed as Record<string, JsonValue>, 'remote', `rename:${crypto.randomUUID()}`);
  input.repo.putEntities(binding.id, entities);
}

import { createHash } from 'node:crypto';

import {
  AtomicConfigCommitUncertainError,
  AtomicConfigExpectedDigestError,
  encodeCandidate,
  type AtomicConfigFile,
  type LocalEntity,
  type PluginRepository,
  type SyncRepository,
} from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';

import { rewireProviderReferences, SyncOperationError, SyncPreviewError } from '../../sync-control-plane';

export type RenameProviderIdentityInput = {
  readonly configPath: string;
  readonly configFile: AtomicConfigFile;
  readonly repo: SyncRepository;
  readonly accounts: Pick<PluginRepository, 'withAccountTransaction' | 'readAccount' | 'renameAccount'>;
  readonly applyCandidate: (
    raw: Record<string, JsonValue>,
    origin: 'local' | 'remote',
    operationId?: string,
    pluginSecret?: { readonly plugin: string; readonly value: JsonValue | undefined },
    expectedDigest?: string,
  ) => Promise<void>;
};

/**
 * Lands the local half of a Provider rename. The `sync_entity` rows alone are not the rename:
 * leaving `providers[oldProviderId]` and the rules pointing at it in the authored configuration
 * makes the next projection miss the renamed included row, so it would publish that row's deletion
 * and reseed the old ID as excluded. The credential and the rows move first, then the authored
 * configuration, as a remote-origin commit so it enqueues no publication of its own — the cloud half
 * of the rename belongs to `applyPreview`.
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
  const digestOf = (value: Record<string, JsonValue>) =>
    createHash('sha256').update(encodeCandidate(value, input.configPath)).digest('hex');
  // The read above is unlocked, and `renamed` is a full-file snapshot: a normal configuration edit
  // landing before the write acquires the lock would be overwritten wholesale, with the outer commit
  // guard adopting the result rather than reporting it. Fencing on the digest of what was read turns
  // that race into a stale preview the user re-reviews.
  const expectedDigest = digestOf(authored);
  const renamed = rewireProviderReferences(authored, oldProviderId, newProviderId);
  const objectIds = new Set(entities.map((entity) => entity.objectId));
  const restore = input.repo.entities(binding.id).filter((entity) => objectIds.has(entity.objectId));
  // The credential and the rows move before the configuration is committed. `renameAccount` refuses
  // while an account operation for either Provider ID is staged, and refusing after the commit would
  // leave the file and the runtime on the new ID with the credential and the rows still on the old
  // one — a split the consumed preview can no longer repair. One transaction, because rows naming
  // the new ID with the credential still under the old one is exactly the unauthorized state this
  // move exists to prevent.
  input.accounts.withAccountTransaction(() => {
    if (moves && !input.accounts.renameAccount(oldProviderId, newProviderId))
      throw new SyncOperationError('operation-pending');
    putEntities(binding.id, entities);
  });
  try {
    await input.applyCandidate(renamed, 'remote', `rename:${crypto.randomUUID()}`, undefined, expectedDigest);
  } catch (error) {
    // A failed candidate leaves the authored configuration on the old Provider ID — the write is
    // rolled back with it — so the local half goes back too rather than stranding the credential and
    // the rows on an ID nothing authors. The collision stays unresolved and is offered again. An
    // uncertain commit may already be durable on the new ID, though, and rolling that back leaves the
    // runtime unauthorized under the ID the file names — a split the consumed preview cannot repair.
    // So the local half only returns when the file still reads as what the candidate was fenced on.
    if (!(error instanceof AtomicConfigCommitUncertainError) || (await unwritten(input, digestOf, expectedDigest)))
      input.accounts.withAccountTransaction(() => {
        if (moves) input.accounts.renameAccount(newProviderId, oldProviderId);
        putEntities(binding.id, restore);
      });
    if (error instanceof AtomicConfigExpectedDigestError) throw new SyncPreviewError('preview-stale');
    throw error;
  }
}

/**
 * Whether the rename's candidate is known not to have reached the file. An unreadable configuration
 * answers `false`: the rename's own in-flight write explains it more readily than a candidate that
 * never landed, and of the two mismatches, undoing a landed rename is the one nothing can repair.
 */
async function unwritten(
  input: RenameProviderIdentityInput,
  digestOf: (value: Record<string, JsonValue>) => string,
  expectedDigest: string,
): Promise<boolean> {
  try {
    return digestOf((await input.configFile.read()) as Record<string, JsonValue>) === expectedDigest;
  } catch {
    return false;
  }
}

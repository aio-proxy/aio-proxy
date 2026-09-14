import { randomUUID } from 'node:crypto';

import type { EntityBody, LocalEntity, LocalBinding, PluginRepository, SyncRepository } from '@aio-proxy/core';
import { retainsSharedOAuth } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncStatus } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import type { PreviewFence, PreviewRecord, RemoteEntity } from '../preview';
import { entitiesDigest, latestCommitId, SyncPreviewError, sameFence } from '../preview';
import { assertDecisions, reviewedBody, type SyncDecision } from './decisions';
import { SyncOperationError } from './errors';
import { providerIdentityRows, remoteIdentityEntity, type ProviderIdentityRows } from './provider-identity';

export { SyncOperationError } from './errors';

/**
 * Refuses to retire a binding whose rows still hold a shared OAuth credential. Ownership is scoped
 * to the account object in that backend's space, so once the binding is inactive nothing can target
 * it: a hold left behind blocks the Provider on every later binding with no operation able to
 * resolve it, while erasing it would drop the only durable record that other devices follow this
 * credential and let the local port rotate the refresh token out from under them. Detaching before
 * the binding goes away is the one resolution that is safe both ways.
 */
export function assertNoRetainedOAuth(repo: SyncRepository, bindingId: string): void {
  const journals = repo.oauthJournals(bindingId);
  if (repo.entities(bindingId).some((entity) => retainsSharedOAuth(entity, journals)))
    throw new SyncOperationError('detach-required');
}

export type OperationInput = {
  readonly repo: SyncRepository;
  readonly binding: () => LocalBinding | null;
  readonly localEntities: () => readonly LocalEntity[];
  readonly remoteEntities: () => Promise<readonly RemoteEntity[]>;
  readonly fence: () => Promise<PreviewFence>;
  readonly status: () => SyncStatus;
  readonly applyLocal: (
    candidate: EntityBody | null,
    current: LocalEntity | undefined,
    objectId: string,
  ) => Promise<void>;
  /**
   * Resolves to the operation ID of the head it wrote, so the local row can record the revision it
   * just published instead of the pre-publication one the preview snapshot carries. `void` covers
   * the injected test doubles and the delete path, which have no new head to name.
   */
  readonly applyCloud: (
    candidate: EntityBody | null,
    current: LocalEntity | undefined,
    expectedVersion: string | null,
  ) => Promise<string | null | void>;
  readonly restore: (
    objectId: string,
    candidate: EntityBody,
    operationId: string,
    current: LocalEntity | undefined,
    expectedVersion: string | null,
  ) => Promise<void>;
  readonly purge: (objectId: string, expectedVersion: string | null) => Promise<void>;
  readonly persistOverrides: (
    objectId: string,
    paths: readonly string[][],
    current: LocalEntity | undefined,
    authored: EntityBody | null,
  ) => Promise<void>;
  /**
   * Publishes a Provider's OAuth account object so other devices can verify the credential rather
   * than holding the Provider at `oauth-unverified`. A `pending` outcome is journalled by the
   * sharing service and completed by its recovery pass, so it is not an error here.
   */
  readonly shareOAuth?: (providerId: string) => Promise<void>;
  /**
   * This device's accounts, read to tell whether an OAuth Provider a decision joins still needs its
   * credential imported.
   */
  readonly accounts?: Pick<PluginRepository, 'readAccount'>;
  /**
   * The control plane's range revision, bumped by every `setRange`. Applying reads it again after
   * each publication because a completed Leave is invisible to the configuration commit fence.
   */
  readonly rangeRevision?: () => number;
  readonly persistProviderIdentity?: (
    oldProviderId: string,
    newProviderId: string,
    entities: readonly LocalEntity[],
  ) => Promise<void>;
  readonly now?: () => number;
};

function isOAuthProvider(body: EntityBody | null): body is EntityBody {
  if (body === null || body.kind !== 'provider' || !isPlainObject(body.value)) return false;
  return (body.value as Record<string, JsonValue>)['kind'] === 'oauth';
}

/**
 * Writes synchronization rows only. Marking a rename's outcome uncertain must not re-enter the
 * identity hook: that hook renames the authored configuration and moves the OAuth account too, so
 * running it again from a failure handler can commit the very rename whose error is about to be
 * rethrown, leaving the caller told the apply was stale while the local rename actually landed.
 */
function persistRows(input: OperationInput, entities: readonly LocalEntity[]): void {
  const binding = input.binding();
  if (binding === null) throw new SyncPreviewError('not-connected');
  const repository = input.repo as SyncRepository & {
    readonly putEntities?: (bindingId: string, entities: readonly LocalEntity[]) => void;
  };
  if (typeof repository.putEntities === 'function') {
    repository.putEntities(binding.id, entities);
    return;
  }
  if (entities.length !== 1 || typeof input.repo.putEntity !== 'function')
    throw new SyncOperationError('upgrade-required');
  input.repo.putEntity(binding.id, entities[0]!);
}

async function persistProviderIdentity(input: OperationInput, rows: ProviderIdentityRows): Promise<void> {
  if (input.persistProviderIdentity !== undefined) {
    await input.persistProviderIdentity(rows.oldProviderId, rows.newProviderId, rows.entities);
    return;
  }
  persistRows(input, rows.entities);
}

export async function assertFresh(input: OperationInput, expected: PreviewFence): Promise<void> {
  const current = await input.fence();
  // The live fence is read without a local capture, so the row digest has to be taken here. Only for
  // a preview that carried one: adding it unconditionally would make every restore and purge Apply
  // stale against its own fence, which has none.
  const observed =
    expected.entitiesDigest === undefined
      ? current
      : { ...current, entitiesDigest: entitiesDigest(input.localEntities()) };
  if (!sameFence(expected, observed)) throw new SyncPreviewError('preview-stale');
}

/**
 * The reviewed fence is taken once, but a multi-row apply makes network round trips per row, so a
 * peer can publish or retire this object before its own decision is reached. Importing a cloud body
 * writes it into the configuration unconditionally — unlike a publication, which is epoch-exact — so
 * the head is read again immediately before the import and a moved one becomes a stale preview
 * rather than a success that silently disagrees with the backend.
 */
async function assertRemoteHeadUnchanged(
  input: OperationInput,
  objectId: string,
  reviewed: RemoteEntity | undefined,
): Promise<void> {
  const current = (await input.remoteEntities()).find((entity) => entity.objectId === objectId);
  if ((current?.version ?? null) !== (reviewed?.version ?? null)) throw new SyncPreviewError('preview-stale');
}

/**
 * The reviewed fence is checked once, but applying then runs network I/O per row, and a
 * configuration commit landing in that window would be overwritten without a word: a cloud choice
 * overlays the reviewed body on the newer one, and a local choice publishes the reviewed body and
 * marks the row included — so the newer edit, committed while the row was still excluded, is never
 * enqueued for publication and no later reconciliation looks for it. Holding the mutation fence
 * across the whole apply is not on offer, because `applyLocal` re-enters that same non-re-entrant
 * queue and would deadlock. Re-reading the confirmed local commit immediately before each mutation
 * is: every commit this apply makes itself is adopted as the new baseline, so only a foreign one
 * stops it. Connect is no exception. Its reviewed fence names the binding the swap replaced, but the
 * swap is already done when applying starts — a commit landing from here on is prepared against the
 * new binding, so that binding's history (empty, on a first connect) is exactly what to compare.
 */
function localCommitGuard(input: OperationInput, binding: LocalBinding) {
  let expected = latestCommitId(input.repo, binding);
  return {
    assertUnchanged(): void {
      if (latestCommitId(input.repo, binding) !== expected) throw new SyncPreviewError('preview-stale');
    },
    adopt(): void {
      expected = latestCommitId(input.repo, binding);
    },
  };
}

export async function applyPreview(
  input: OperationInput,
  record: PreviewRecord,
  decisions: readonly SyncDecision[],
): Promise<SyncStatus> {
  const binding = input.binding();
  if (binding === null) throw new SyncPreviewError('not-connected');
  if (input.now?.() !== undefined && input.now!() >= record.expiresAt) throw new SyncPreviewError('preview-stale');
  await assertFresh(input, record.fence);
  const selected = new Map(decisions.map((decision) => [decision.objectId, decision]));
  const localByObject = new Map(record.local.map((entity) => [entity.objectId, entity]));
  const remoteByObject = new Map(record.remote.map((entity) => [entity.objectId, entity]));
  const commits = localCommitGuard(input, binding);
  if (record.input.kind === 'purge') {
    if (record.dependencyError) throw new SyncOperationError('dependency-in-use');
    const purge = record.input;
    const targetKind = purge.scope === 'provider' ? 'provider' : 'plugin-business';
    // buildPreview lists transitive cloud dependents so the user can see what a purge would
    // orphan. Purging is permanent, so they are blockers, not collateral: erase only the
    // requested object and make the user delete or rewrite anything still depending on it.
    if (
      record.rows.some((candidate) => candidate.row.kind !== targetKind || candidate.row.logicalKey !== purge.objectId)
    )
      throw new SyncOperationError('dependency-in-use');
    for (const candidate of record.rows) {
      const remote = remoteByObject.get(candidate.row.objectId);
      if (remote === undefined) continue;
      // Erasing is permanent and reconciliation applies the resulting tombstone to the
      // configuration, so a commit landing after the preview was reviewed would be deleted by an
      // erase it was never shown against. Same rule as every other mutation here, and a purge makes
      // no local commit of its own to adopt.
      commits.assertUnchanged();
      await input.purge(candidate.row.objectId, remote?.version ?? null);
      const verified = (await input.remoteEntities()).find((entity) => entity.objectId === candidate.row.objectId);
      if (verified !== undefined && verified.tombstone !== true) throw new SyncOperationError('operation-pending');
    }
    return input.status();
  }
  assertDecisions(record, decisions);
  if (record.input.kind === 'overrides') {
    const objectId = record.input.objectId;
    const current = localByObject.get(objectId);
    // The row's local body, which buildPreview projects from the authored configuration. The
    // synchronization row's `desired` is the published body, so it is null for a local-only object
    // and would record every pinned path as a deletion of the value the user asked to keep.
    const authored = record.rows.find((candidate) => candidate.row.objectId === objectId)?.local ?? null;
    commits.assertUnchanged();
    await input.persistOverrides(objectId, record.input.paths, current, authored);
  }
  for (const candidate of record.rows) {
    const decision = selected.get(candidate.row.objectId);
    if (decision === undefined) {
      // Only connect gets here; assertDecisions demands a decision for every other kind. The row
      // was carried across the swap with the previous binding's mode, which says nothing about
      // this backend: leaving it included reports it as synchronized and lets the next local
      // commit publish what the user declined to join.
      const carried = input.localEntities().find((entity) => entity.objectId === candidate.row.objectId);
      if (carried !== undefined && carried.mode !== 'excluded' && typeof input.repo.putEntity === 'function')
        input.repo.putEntity(binding.id, { ...carried, mode: 'excluded', pendingReason: null });
      continue;
    }
    const current = localByObject.get(candidate.row.objectId);
    const remote = remoteByObject.get(candidate.row.objectId);
    let identityRows: ProviderIdentityRows | undefined;
    let identityBase: LocalEntity | undefined;
    let selectedBody = reviewedBody(record, candidate, decision.choice, remote);
    if (decision.newProviderId !== undefined && selectedBody !== null) {
      selectedBody = { ...selectedBody, logicalKey: decision.newProviderId };
      identityBase = current ?? remoteIdentityEntity(candidate.row.objectId, remote);
      // Every row of a collision group names an identity, including the one that keeps the
      // contested ID. That is not a rename: republishing it as a new object would delete the head
      // it still holds.
      if (identityBase !== undefined && identityBase.logicalKey !== decision.newProviderId) {
        // Renaming a published head replaces it with a new object, and OAuth ownership names the
        // account object under the old one. Carrying it over leaves `share()` reporting the
        // credential as already shared while no account exists for the new object — the renamed
        // Provider is then unusable on every other device — and dropping it would let the local
        // port rotate a refresh token the devices following the old account still use. Detaching
        // first is the one resolution that is safe both ways, so the rename asks for it. Read from
        // the live rows: ownership a login recorded after the preview is no part of the fence.
        const owner = input.localEntities().find((entity) => entity.objectId === identityBase!.objectId);
        if (remote?.body != null && retainsSharedOAuth(owner ?? identityBase, input.repo.oauthJournals(binding.id)))
          throw new SyncOperationError('detach-required');
        identityRows = providerIdentityRows(
          identityBase,
          selectedBody,
          decision.newProviderId,
          record.local,
          remote?.body != null,
        );
      }
    }
    // A remote-only row has nothing authored to rewire — applyLocal writes the imported body under
    // the new ID — and rewiring would rename whichever local Provider still holds the old one,
    // which in a collision is a different object.
    commits.assertUnchanged();
    if (identityRows !== undefined && current !== undefined) {
      await persistProviderIdentity(input, identityRows);
      commits.adopt();
    }
    let published = false;
    let publishedRevision: string | null = null;
    const recordJoin = (): void => {
      if (typeof input.repo.putEntity !== 'function') return;
      // A rename republishes the configuration as a new object, so the row to join is the renamed
      // one. Skipping it instead would report success while leaving the Provider outside
      // synchronization — reconciliation had already quarantined the colliding row as `excluded`,
      // and providerIdentityRows carries that mode onto the replacement.
      const joined = identityRows?.renamed ?? current;
      // A commit landing during the publication has no next row to catch it, and joining buries it.
      commits.assertUnchanged();
      // `current` is the preview snapshot, taken before persistOverrides() wrote this row's paths
      // and blind to OAuth ownership a concurrent login or refresh recorded — neither is part of
      // the fence. Re-read the row and carry over only the fields applying actually decides.
      // An imported cloud-only object has no snapshot row at all; the import just created one, and
      // bailing out here would leave that row at the defaults the port writes — no baseline, no
      // pending reason — which for an OAuth Provider reads as a verified local credential.
      const objectId = joined?.objectId ?? candidate.row.objectId;
      const latest = input.localEntities().find((entity) => entity.objectId === objectId) ?? joined;
      if (latest === undefined) return;
      // A `sync leave` completing while this publication was in flight stores the row excluded and
      // bumps the range revision. The commit fence cannot see it — `setRange` writes no
      // configuration commit — so forcing `included` back here would silently undo a Leave the user
      // already got a success for. The publication itself still happened, so only the mode defers.
      const left =
        (input.rangeRevision?.() ?? record.fence.rangeRevision) !== record.fence.rangeRevision &&
        latest.mode === 'excluded';
      // Applying an OAuth Provider carries its configuration only: the separately published account
      // object is imported by reconciliation's activation check, and a row left with the cloud
      // baseline and no pending reason is exactly what that pass skips. Holding it at the state it is
      // actually in keeps the row eligible, so the credential arrives instead of the Provider sitting
      // unauthorized until some later publication moves the head. What verifies the row is its
      // recorded ownership, not the mere presence of an account: a device that already had its own
      // credential under this Provider ID shares nothing with the account published for this object,
      // and the resolver hands an ownership-less row to the local refresh path, which rotates that
      // credential out from under every device following the shared one. Sharing attaches, replaces,
      // or proves it independent, and each of those records ownership.
      const unverified =
        isOAuthProvider(selectedBody) &&
        input.accounts !== undefined &&
        (latest.oauth === undefined || input.accounts.readAccount(selectedBody.logicalKey) === null);
      input.repo.putEntity(binding.id, {
        ...latest,
        mode: left ? 'excluded' : 'included',
        desired: selectedBody,
        // The preview's `remote.revision` predates this publication, so recording it would leave
        // the row permanently behind its own write and make the next reconcile see phantom drift.
        // After a rename it names the object the rename vacated, which this row no longer follows.
        baseline: publishedRevision ?? (identityRows === undefined ? remote?.revision : null) ?? latest.baseline,
        pendingReason: unverified ? 'oauth-unverified' : null,
      });
    };
    // Retiring a head leaves nothing for this row to follow, so it stops synchronizing. Leaving it
    // included would also hand reconciliation's tombstone pass a live row, and that pass deletes the
    // authored object from the configuration file — while the identity's surviving head is exactly
    // what the user chose to keep here.
    const recordDeletion = (): void => {
      if (current === undefined || typeof input.repo.putEntity !== 'function') return;
      commits.assertUnchanged();
      const latest = input.localEntities().find((entity) => entity.objectId === candidate.row.objectId) ?? current;
      input.repo.putEntity(binding.id, { ...latest, mode: 'excluded', pendingReason: null });
    };
    try {
      if (decision.choice === 'delete') {
        // A cloud-only duplicate has no local row, and the delete is epoch-exact, so the head's own
        // epoch is synthesized from the reviewed remote entity.
        await input.applyCloud(
          null,
          current ?? remoteIdentityEntity(candidate.row.objectId, remote),
          remote?.version ?? null,
        );
        recordDeletion();
      } else if ((decision.choice === 'restore' || record.input.kind === 'restore') && selectedBody !== null) {
        // Restoring republishes a historical body as a new revision, so it needs an operation ID no
        // head has a receipt for. Reusing the one being restored reads as an idempotent replay:
        // publishing reports success without moving `head.current`, the local row then records the
        // historical body against the still-current remote baseline, and reconciliation sees no
        // discrepancy — a restore that silently did nothing.
        const operationId = `restore:${candidate.row.objectId}:${randomUUID()}`;
        await input.restore(candidate.row.objectId, selectedBody, operationId, current, remote?.version ?? null);
        // The restored body is a cloud body, so it has to reach the configuration file the same way
        // a cloud choice does. Recording it only on the row would leave the file holding the
        // pre-restore value (or nothing, after a deletion) until some later reconciliation, and any
        // configuration commit in that window projects the stale file over the restore.
        publishedRevision = operationId;
        // The guard above ran before the restore's round trip. Importing the historical body
        // overlays a commit that landed in that window, and the `adopt()` below takes the result as
        // the new baseline, so the edit would be gone with nothing left to republish it.
        commits.assertUnchanged();
        await input.applyLocal(selectedBody, current, candidate.row.objectId);
        commits.adopt();
      } else if (decision.choice === 'cloud') {
        await assertRemoteHeadUnchanged(input, candidate.row.objectId, remote);
        // Importing alone would leave the head under the old Provider ID, and the next
        // reconciliation would restore that ID and quarantine the same collision again. Publish the
        // renamed object first, then bind the local row to the object the cloud now agrees with.
        if (identityRows !== undefined) {
          publishedRevision = (await input.applyCloud(selectedBody, identityRows.renamed, null)) ?? null;
          if (identityRows.replacesPublished) await input.applyCloud(null, identityBase, remote?.version ?? null);
        }
        // The head check above lists and reads the whole backend, and the publication before it is
        // another round trip. A commit landing in either window is overlaid by the import below and
        // then buried by `adopt()`, so the guard runs here rather than before the network work.
        commits.assertUnchanged();
        await input.applyLocal(selectedBody, current, identityRows?.renamed.objectId ?? candidate.row.objectId);
        commits.adopt();
      } else if (identityRows !== undefined) {
        // The renamed object is published first so the configuration is never absent from the cloud,
        // then the identity it vacated is deleted. A fresh object has no expected version.
        publishedRevision =
          (await input.applyCloud(
            selectedBody,
            identityRows.renamed,
            identityRows.replacesPublished ? null : (remote?.version ?? null),
          )) ?? null;
        if (identityRows.replacesPublished) await input.applyCloud(null, identityBase, remote?.version ?? null);
        published = true;
      } else {
        publishedRevision = (await input.applyCloud(selectedBody, current, remote?.version ?? null)) ?? null;
        published = true;
      }
      // Sharing refuses a row the repository still has excluded and reports `pending`, which the
      // integration drops: the Provider would go out without its account and hold every peer at
      // `oauth-unverified` until this service restarts. The publication has already landed here, so
      // recording the reviewed join before sharing is also the truthful order.
      if (decision.choice !== 'delete') recordJoin();
      // Publishing an OAuth Provider carries only its configuration. Until its account object is
      // published too, every other device sees the Provider and holds it at `oauth-unverified`,
      // and nothing else seeds it for a Provider that was authorized before sync was enabled.
      if (published && isOAuthProvider(selectedBody)) await input.shareOAuth?.(selectedBody.logicalKey);
    } catch (error) {
      if (identityRows !== undefined && current !== undefined) {
        persistRows(
          input,
          identityRows.entities.map((entity) => ({ ...entity, pendingReason: 'result-uncertain' })),
        );
      }
      throw error;
    }
  }
  return input.status();
}

export function setRange(input: OperationInput, providerId: string): SyncStatus {
  const binding = input.binding();
  if (binding === null) throw new SyncPreviewError('not-connected');
  const entity = input
    .localEntities()
    .find((candidate) => candidate.logicalKey === providerId && candidate.kind === 'provider');
  if (entity === undefined) throw new SyncOperationError('upgrade-required');
  input.repo.putEntity(binding.id, { ...entity, mode: 'excluded', pendingReason: null });
  return input.status();
}

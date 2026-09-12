import { randomUUID } from 'node:crypto';

import type { EntityBody, LocalEntity, LocalBinding, PluginRepository, SyncRepository } from '@aio-proxy/core';
import { isTombstonedEntity, retainsSharedOAuth } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncStatus } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import type { PreviewFence, PreviewRecord, RemoteEntity } from '../preview';
import { latestCommitId, SyncPreviewError, sameFence } from '../preview';
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

async function persistProviderIdentity(input: OperationInput, rows: ProviderIdentityRows): Promise<void> {
  if (input.persistProviderIdentity !== undefined) {
    await input.persistProviderIdentity(rows.oldProviderId, rows.newProviderId, rows.entities);
    return;
  }
  const binding = input.binding();
  if (binding === null) throw new SyncPreviewError('not-connected');
  const repository = input.repo as SyncRepository & {
    readonly putEntities?: (bindingId: string, entities: readonly LocalEntity[]) => void;
  };
  if (typeof repository.putEntities === 'function') {
    repository.putEntities(binding.id, rows.entities);
    return;
  }
  if (rows.entities.length !== 1 || typeof input.repo.putEntity !== 'function')
    throw new SyncOperationError('upgrade-required');
  input.repo.putEntity(binding.id, rows.entities[0]!);
}

export async function assertFresh(input: OperationInput, expected: PreviewFence): Promise<void> {
  const current = await input.fence();
  if (!sameFence(expected, current)) throw new SyncPreviewError('preview-stale');
}

export type SyncDecision = { objectId: string; choice: 'local' | 'cloud' | 'restore'; newProviderId?: string };

/**
 * A replacement Provider ID resolves a collision only if it is free once every decision lands.
 * `providerIdentityRows` sees one row and the local entities alone, so two cloud-only rows can claim
 * the same replacement and a replacement can land on a Provider the preview never listed — after
 * which applying publishes two heads under one Provider ID, overwrites the matching local entry, and
 * the next reconciliation quarantines the same collision the flow was supposed to clear.
 */
function assertProviderIdentitiesFree(record: PreviewRecord, selected: ReadonlyMap<string, SyncDecision>): void {
  const holders = new Map<string, string>();
  const claim = (objectId: string, logicalKey: string): void => {
    const key = selected.get(objectId)?.newProviderId ?? logicalKey;
    const held = holders.get(key);
    if (held !== undefined && held !== objectId) throw new SyncOperationError('upgrade-required');
    holders.set(key, objectId);
  };
  // Deleting an object frees its Provider ID, so another device may already publish a live object
  // under it while the local tombstone is still retained. Claiming both sides of that handover would
  // reject every decision as a collision on an ID no local row owns any more — the same rule
  // reconciliation applies, and the same one the remote loop below applies to its own tombstones.
  for (const entity of record.local)
    if (entity.kind === 'provider' && !isTombstonedEntity(entity)) claim(entity.objectId, entity.logicalKey);
  for (const entity of record.remote)
    // A tombstone holds no identity: its Provider ID is exactly what a rename is free to take.
    if (entity.kind === 'provider' && entity.tombstone !== true) claim(entity.objectId, entity.logicalKey);
}

/**
 * The purely-local half of applying: does this decision set match the reviewed rows? It touches no
 * repository and no backend, so callers can reject a malformed request before anything is committed.
 */
export function assertDecisions(record: PreviewRecord, decisions: readonly SyncDecision[]): void {
  const selected = new Map(decisions.map((decision) => [decision.objectId, decision]));
  const rowIds = new Set(record.rows.map((candidate) => candidate.row.objectId));
  if (selected.size !== decisions.length || decisions.some((decision) => !rowIds.has(decision.objectId)))
    throw new SyncOperationError('upgrade-required');
  // Applying consumes the preview, so an omitted decision would silently skip its row and still
  // report success. Overrides are worse: their paths persist before the decision loop below.
  // Connecting is the one exception, and only for a row with nothing on the cloud side: it joins
  // nothing, so leaving it out is how connect's documented default — every object excluded until
  // it is joined — is expressed. buildPreview marks those rows `optional`, which is the same rule
  // the dialog reads to leave them unselected. A row carrying cloud state still needs an explicit
  // choice, because the post-swap reconciliation would otherwise import it unreviewed.
  if (record.rows.some((candidate) => !selected.has(candidate.row.objectId) && candidate.row.optional !== true))
    throw new SyncOperationError('upgrade-required');
  for (const candidate of record.rows) {
    const decision = selected.get(candidate.row.objectId);
    if (decision === undefined) continue;
    if (candidate.requiresProviderId && decision.newProviderId === undefined)
      throw new SyncOperationError('upgrade-required');
    if (decision.newProviderId !== undefined && candidate.row.kind !== 'provider')
      throw new SyncOperationError('upgrade-required');
    if (!candidate.row.choices.includes(decision.choice)) throw new SyncOperationError('upgrade-required');
  }
  assertProviderIdentitiesFree(record, selected);
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
 * stops it. Connect is exempt for the same reason its fence is neutralized — the swap replaces the
 * binding's commit history wholesale, so there is nothing stable to compare against.
 */
function localCommitGuard(input: OperationInput, record: PreviewRecord, binding: LocalBinding) {
  let expected = record.input.kind === 'connect' ? undefined : latestCommitId(input.repo, binding);
  return {
    assertUnchanged(): void {
      if (expected !== undefined && latestCommitId(input.repo, binding) !== expected)
        throw new SyncPreviewError('preview-stale');
    },
    adopt(): void {
      if (expected !== undefined) expected = latestCommitId(input.repo, binding);
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
      await input.purge(candidate.row.objectId, remote?.version ?? null);
      const verified = (await input.remoteEntities()).find((entity) => entity.objectId === candidate.row.objectId);
      if (verified !== undefined && verified.tombstone !== true) throw new SyncOperationError('operation-pending');
    }
    return input.status();
  }
  assertDecisions(record, decisions);
  const commits = localCommitGuard(input, record, binding);
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
    let selectedBody =
      decision.choice === 'local'
        ? candidate.local
        : decision.choice === 'cloud'
          ? candidate.cloud
          : record.input.kind === 'restore'
            ? candidate.cloud
            : (candidate.restoreBody ?? remoteByObject.get(candidate.row.objectId)?.body ?? null);
    if (decision.newProviderId !== undefined && selectedBody !== null) {
      selectedBody = { ...selectedBody, logicalKey: decision.newProviderId };
      identityBase = current ?? remoteIdentityEntity(candidate.row.objectId, remote);
      // Every row of a collision group names an identity, including the one that keeps the
      // contested ID. That is not a rename: republishing it as a new object would delete the head
      // it still holds.
      if (identityBase !== undefined && identityBase.logicalKey !== decision.newProviderId)
        identityRows = providerIdentityRows(
          identityBase,
          selectedBody,
          decision.newProviderId,
          record.local,
          remote?.body != null,
        );
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
      if (identityRows !== undefined || current === undefined || typeof input.repo.putEntity !== 'function') return;
      // A commit landing during the publication has no next row to catch it, and joining buries it.
      commits.assertUnchanged();
      // `current` is the preview snapshot, taken before persistOverrides() wrote this row's paths
      // and blind to OAuth ownership a concurrent login or refresh recorded — neither is part of
      // the fence. Re-read the row and carry over only the fields applying actually decides.
      const latest = input.localEntities().find((entity) => entity.objectId === candidate.row.objectId) ?? current;
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
      // unauthorized until some later publication moves the head.
      const unverified = isOAuthProvider(selectedBody) && input.accounts?.readAccount(selectedBody.logicalKey) === null;
      input.repo.putEntity(binding.id, {
        ...latest,
        mode: left ? 'excluded' : 'included',
        desired: selectedBody,
        // The preview's `remote.revision` predates this publication, so recording it would leave
        // the row permanently behind its own write and make the next reconcile see phantom drift.
        baseline: publishedRevision ?? remote?.revision ?? latest.baseline,
        pendingReason: unverified ? 'oauth-unverified' : null,
      });
    };
    try {
      if ((decision.choice === 'restore' || record.input.kind === 'restore') && selectedBody !== null) {
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
        await input.applyLocal(selectedBody, current, candidate.row.objectId);
        commits.adopt();
      } else if (decision.choice === 'cloud') {
        // Importing alone would leave the head under the old Provider ID, and the next
        // reconciliation would restore that ID and quarantine the same collision again. Publish the
        // renamed object first, then bind the local row to the object the cloud now agrees with.
        if (identityRows !== undefined) {
          await input.applyCloud(selectedBody, identityRows.renamed, null);
          if (identityRows.replacesPublished) await input.applyCloud(null, identityBase, remote?.version ?? null);
          commits.assertUnchanged();
        }
        await input.applyLocal(selectedBody, current, identityRows?.renamed.objectId ?? candidate.row.objectId);
        commits.adopt();
      } else if (identityRows !== undefined) {
        // The renamed object is published first so the configuration is never absent from the cloud,
        // then the identity it vacated is deleted. A fresh object has no expected version.
        await input.applyCloud(
          selectedBody,
          identityRows.renamed,
          identityRows.replacesPublished ? null : (remote?.version ?? null),
        );
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
      recordJoin();
      // Publishing an OAuth Provider carries only its configuration. Until its account object is
      // published too, every other device sees the Provider and holds it at `oauth-unverified`,
      // and nothing else seeds it for a Provider that was authorized before sync was enabled.
      if (published && isOAuthProvider(selectedBody)) await input.shareOAuth?.(selectedBody.logicalKey);
    } catch (error) {
      if (identityRows !== undefined && current !== undefined) {
        await persistProviderIdentity(input, {
          ...identityRows,
          entities: identityRows.entities.map((entity) => ({ ...entity, pendingReason: 'result-uncertain' })),
        });
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

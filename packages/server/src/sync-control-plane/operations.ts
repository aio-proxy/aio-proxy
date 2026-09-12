import { randomUUID } from 'node:crypto';

import type { EntityBody, LocalEntity, LocalBinding, SyncRepository } from '@aio-proxy/core';
import { retainsSharedOAuth } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncStatus } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import type { PreviewFence, PreviewRecord, RemoteEntity } from './preview';
import { SyncPreviewError, sameFence } from './preview';

export class SyncOperationError extends Error {
  override readonly name = 'SyncOperationError';
  constructor(
    readonly code:
      | 'not-connected'
      | 'dependency-in-use'
      | 'detach-required'
      | 'operation-pending'
      | 'upgrade-required'
      | 'backend-unavailable',
  ) {
    super(code);
  }
}

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
  readonly persistProviderIdentity?: (
    oldProviderId: string,
    newProviderId: string,
    entities: readonly LocalEntity[],
  ) => Promise<void>;
  readonly now?: () => number;
};

type ProviderIdentityRows = {
  readonly oldProviderId: string;
  readonly newProviderId: string;
  readonly entities: readonly LocalEntity[];
  /** The renamed row itself, which carries a fresh object identity once the old one was published. */
  readonly renamed: LocalEntity;
  /** Whether the old object still exists remotely and has to be removed after the rename lands. */
  readonly replacesPublished: boolean;
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Moves every reference to `oldProviderId` onto `newProviderId`: the keys of `providers`/`accounts`
 * maps and the `providerId`/`accountProviderId` scalars that name them. Shared by the entity bodies
 * a rename publishes and the authored configuration those bodies are projected from, so the two can
 * never disagree about which Provider ID a rule points at.
 */
export function rewireProviderReferences(value: JsonValue, oldProviderId: string, newProviderId: string): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => rewireProviderReferences(entry, oldProviderId, newProviderId));
  if (!isPlainObject(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'providers' || key === 'accounts') {
      if (!isPlainObject(child)) throw new SyncOperationError('upgrade-required');
      const references = { ...(child as Record<string, JsonValue>) };
      if (Object.hasOwn(references, oldProviderId)) {
        if (Object.hasOwn(references, newProviderId)) throw new SyncOperationError('upgrade-required');
        references[newProviderId] = references[oldProviderId]!;
        delete references[oldProviderId];
      }
      result[key] = rewireProviderReferences(references, oldProviderId, newProviderId);
    } else if ((key === 'providerId' || key === 'accountProviderId') && child === oldProviderId) {
      result[key] = newProviderId;
    } else result[key] = rewireProviderReferences(child, oldProviderId, newProviderId);
  }
  return result;
}

function isOAuthProvider(body: EntityBody | null): body is EntityBody {
  if (body === null || body.kind !== 'provider' || !isPlainObject(body.value)) return false;
  return (body.value as Record<string, JsonValue>)['kind'] === 'oauth';
}

function validateStructuredReferenceMaps(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const entry of value) validateStructuredReferenceMaps(entry);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'providers' || key === 'accounts') && !isPlainObject(child))
      throw new SyncOperationError('upgrade-required');
    validateStructuredReferenceMaps(child);
  }
}

function providerIdentityRows(
  current: LocalEntity,
  selected: EntityBody,
  newProviderId: string,
  entities: readonly LocalEntity[],
  published: boolean,
): ProviderIdentityRows {
  if (current.kind !== 'provider' || selected.kind !== 'provider' || newProviderId === '')
    throw new SyncOperationError('upgrade-required');
  validateStructuredReferenceMaps(selected.value);
  if (
    entities.some(
      (entity) =>
        entity.objectId !== current.objectId && entity.kind === 'provider' && entity.logicalKey === newProviderId,
    )
  )
    throw new SyncOperationError('upgrade-required');
  // A published head's logical key is immutable, so the rename cannot be pushed through the same
  // object. The renamed configuration becomes a new object and the old one is deleted afterwards,
  // which is also what clears the colliding identity out of the cloud.
  const renamed: LocalEntity = {
    ...current,
    logicalKey: newProviderId,
    desired: { ...selected, logicalKey: newProviderId },
    ...(published ? { objectId: crypto.randomUUID(), epoch: 0, baseline: null } : {}),
  };
  const mapped = entities.map((entity) => {
    if (entity.objectId === current.objectId) return renamed;
    if (entity.desired?.kind !== 'model-rule') return entity;
    return {
      ...entity,
      desired: {
        ...entity.desired,
        value: rewireProviderReferences(entity.desired.value, current.logicalKey, newProviderId),
      },
    };
  });
  return {
    oldProviderId: current.logicalKey,
    newProviderId,
    renamed,
    replacesPublished: published,
    // Persist only rows whose provider identity or structured references changed. This lets a
    // repository that predates bulk persistence handle a provider-only rename atomically while
    // still refusing a multi-row mapping that it cannot write as one transaction.
    entities: mapped.filter((entity, index) => !sameJson(entity, entities[index])),
  };
}

/**
 * The entity a rename needs when the colliding object lives only in the cloud. Its identity group
 * is entirely remote, so there is nothing local to rename — but the rename still has to reach the
 * backend, or the immutable head keeps the old Provider ID and the next reconciliation quarantines
 * the same collision again.
 */
function remoteIdentityEntity(objectId: string, remote: RemoteEntity | undefined): LocalEntity | undefined {
  if (remote?.body == null || remote.kind !== 'provider') return undefined;
  return {
    objectId,
    logicalKey: remote.logicalKey,
    kind: 'provider',
    mode: 'included',
    // Deleting the head it vacates is an epoch-exact operation, so the remote epoch is the one
    // field that cannot be defaulted away.
    epoch: remote.epoch ?? 0,
    desired: remote.body,
    baseline: remote.revision,
    overrides: [],
    pendingReason: null,
  };
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
  if (record.input.kind === 'overrides') {
    const objectId = record.input.objectId;
    const current = localByObject.get(objectId);
    // The row's local body, which buildPreview projects from the authored configuration. The
    // synchronization row's `desired` is the published body, so it is null for a local-only object
    // and would record every pinned path as a deletion of the value the user asked to keep.
    const authored = record.rows.find((candidate) => candidate.row.objectId === objectId)?.local ?? null;
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
    if (identityRows !== undefined && current !== undefined) await persistProviderIdentity(input, identityRows);
    let published = false;
    let publishedRevision: string | null = null;
    try {
      if ((decision.choice === 'restore' || record.input.kind === 'restore') && selectedBody !== null) {
        let operationId: string;
        if (decision.choice === 'restore') {
          operationId =
            record.input.kind === 'restore' ? record.input.operationId : `restore:${candidate.row.objectId}`;
        } else {
          if (record.input.kind !== 'restore') throw new SyncOperationError('upgrade-required');
          operationId = `restore:${record.input.operationId}:${randomUUID()}`;
        }
        await input.restore(candidate.row.objectId, selectedBody, operationId, current, remote?.version ?? null);
      } else if (decision.choice === 'cloud') {
        // Importing alone would leave the head under the old Provider ID, and the next
        // reconciliation would restore that ID and quarantine the same collision again. Publish the
        // renamed object first, then bind the local row to the object the cloud now agrees with.
        if (identityRows !== undefined) {
          await input.applyCloud(selectedBody, identityRows.renamed, null);
          if (identityRows.replacesPublished) await input.applyCloud(null, identityBase, remote?.version ?? null);
        }
        await input.applyLocal(selectedBody, current, identityRows?.renamed.objectId ?? candidate.row.objectId);
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
    if (identityRows === undefined && current !== undefined && typeof input.repo.putEntity === 'function') {
      // `current` is the preview snapshot, taken before persistOverrides() wrote this row's paths
      // and blind to OAuth ownership a concurrent login or refresh recorded — neither is part of
      // the fence. Re-read the row and carry over only the fields applying actually decides.
      const latest = input.localEntities().find((entity) => entity.objectId === candidate.row.objectId) ?? current;
      input.repo.putEntity(binding.id, {
        ...latest,
        mode: 'included',
        desired: selectedBody,
        // The preview's `remote.revision` predates this publication, so recording it would leave
        // the row permanently behind its own write and make the next reconcile see phantom drift.
        baseline: publishedRevision ?? remote?.revision ?? latest.baseline,
        pendingReason: null,
      });
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

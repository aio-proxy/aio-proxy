import type { EntityBody } from '@aio-proxy/core';
import { isTombstonedEntity } from '@aio-proxy/core';

import type { PreviewCandidate, PreviewRecord, RemoteEntity } from '../preview';
import { SyncOperationError } from './errors';

export type SyncDecision = {
  objectId: string;
  choice: 'local' | 'cloud' | 'restore' | 'delete';
  newProviderId?: string;
};

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
 * Which body the apply publishes and writes for a reviewed row. `restore` is the only choice that is
 * not literally one of the two displayed sides: in a restore preview it is the resolved historical
 * revision, projected as `cloud`. Everywhere else it is offered on one row only — a tombstoned head
 * whose local side still has a body, a Provider a peer deleted while this device kept its
 * configuration and is now rejoining. Reviving that with the retained historical revision would
 * publish a body the preview never displayed and then write it over the authored configuration, so
 * the reviewed local body is what the revive publishes.
 */
export function reviewedBody(
  record: PreviewRecord,
  candidate: PreviewCandidate,
  choice: SyncDecision['choice'],
  remote: RemoteEntity | undefined,
): EntityBody | null {
  if (choice === 'local') return candidate.local;
  if (choice === 'cloud') return candidate.cloud;
  if (record.input.kind === 'restore') return candidate.cloud;
  return candidate.local ?? candidate.restoreBody ?? remote?.body ?? null;
}

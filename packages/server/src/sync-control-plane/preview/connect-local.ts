import { authoredEntityIdentities, type CommittedSource, type LocalEntity } from '@aio-proxy/core';

import type { RemoteEntity } from './entities';

function identityKey(kind: string, logicalKey: string): string {
  return `${kind}\0${logicalKey}`;
}

/**
 * The local rows a connect review needs for authored objects the candidate backend already holds.
 * `sync_entity` rows belong to a binding, so a first connect has none: without these the authored
 * configuration is invisible to the preview, the colliding identity is reviewed as a cloud-only add
 * offering `cloud` alone, and applying imports the cloud body over the authored object — the very
 * decision S12 requires the user to make. Rows are minted at the cloud object's own ID, which is the
 * ID `seedAuthoredEntities` reserves for that identity anyway, so one row carries both sides instead
 * of two rows colliding over one Provider ID. The epoch comes from the cloud head, because a local
 * choice publishes onto it and an epoch the backend never issued is rejected.
 */
export function authoredLocalEntities(
  source: CommittedSource,
  local: readonly LocalEntity[],
  remote: readonly RemoteEntity[],
): readonly LocalEntity[] {
  const known = new Set(local.map((entity) => identityKey(entity.kind, entity.logicalKey)));
  const claimed = new Map<string, RemoteEntity>();
  // A tombstone claims nothing: its identity is free, so the authored object stays local-only and is
  // seeded as an ordinary excluded row by the connect that follows.
  for (const entity of remote)
    if (entity.body !== null || (entity.restoreBody ?? null) !== null)
      claimed.set(identityKey(entity.kind, entity.logicalKey), entity);
  const minted: LocalEntity[] = [];
  for (const identity of authoredEntityIdentities(source.raw)) {
    const key = identityKey(identity.kind, identity.logicalKey);
    const head = claimed.get(key);
    if (head === undefined || known.has(key)) continue;
    known.add(key);
    minted.push({
      objectId: head.objectId,
      logicalKey: identity.logicalKey,
      kind: identity.kind,
      // Connect publishes nothing until a decision says so, and the reviewed decision writes the
      // mode itself. Excluded is also what seeding would have written for this row.
      mode: 'excluded',
      epoch: head.epoch ?? 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    });
  }
  return minted;
}

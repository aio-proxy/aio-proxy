import { decodeHead, decodeRevision, entityKey, revisionKey, type EntityBody, type LocalEntity } from '@aio-proxy/core';
import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { SyncPreviewError } from './errors';

export type RemoteEntity = {
  readonly objectId: string;
  readonly logicalKey: string;
  readonly kind: string;
  /** The head's epoch, which a delete has to name exactly. Absent only in injected snapshots. */
  readonly epoch?: number;
  readonly version: string | null;
  /** Current protocol revision operation ID; this is the sync baseline identity. */
  readonly revision: string | null;
  readonly body: EntityBody | null;
  readonly tombstone?: boolean;
  readonly revisions?: Readonly<Record<string, EntityBody | null>>;
  readonly restoreBody?: EntityBody | null;
};

function snapshotBody(body: EntityBody | null | undefined): EntityBody | null | undefined {
  if (body === null || body === undefined) return body;
  return {
    ...body,
    value: structuredClone(body.value),
    dependencies: body.dependencies.map((dependency) => ({ ...dependency })),
  };
}

export function snapshotRemoteEntities(remote: readonly RemoteEntity[]): RemoteEntity[] {
  return remote.map((entity) => ({
    ...entity,
    version: entity.version,
    revision: entity.revision,
    body: snapshotBody(entity.body) ?? null,
    revisions:
      entity.revisions === undefined
        ? undefined
        : Object.fromEntries(Object.entries(entity.revisions).map(([id, body]) => [id, snapshotBody(body) ?? null])),
    restoreBody: snapshotBody(entity.restoreBody),
  }));
}

export function snapshotLocalEntities(local: readonly LocalEntity[]): LocalEntity[] {
  return local.map((entity) => ({
    ...entity,
    desired: snapshotBody(entity.desired) ?? null,
    overrides: entity.overrides.map((override) => ({
      ...override,
      ...(override.value === undefined ? {} : { value: structuredClone(override.value) }),
    })),
    oauth: entity.oauth === undefined ? undefined : { ...entity.oauth },
  }));
}

const ENTITY_PREFIX = 's/v1/default/entity/';

export async function listRemoteEntities(
  session: SyncSession | undefined,
  signal: AbortSignal,
): Promise<RemoteEntity[]> {
  // A bound backend that never connected is offline, not empty. Read as an empty cloud, a purge
  // preview lists no rows at all — and applying it then erases nothing, reports success, and leaves
  // the configuration, its history and the account in place.
  if (session === undefined) throw new SyncPreviewError('not-connected');
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.list({ prefix: ENTITY_PREFIX, ...(cursor === undefined ? {} : { cursor }) }, signal);
    keys.push(...page.keys);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const result: RemoteEntity[] = [];
  for (const key of keys) {
    const objectId = key.slice(ENTITY_PREFIX.length);
    if (objectId === '') continue;
    const value = await session.read(entityKey(objectId), signal);
    if (value.kind === 'absent') continue;
    const head = decodeHead(value.value);
    if (head.objectId !== objectId) throw new SyncPreviewError('not-connected');
    if (head.state === 'purging') throw new SyncPreviewError('not-connected');
    let body: EntityBody | null = null;
    // A delete only flips `state`; `current` keeps pointing at the last payload. Reporting that
    // payload as the live cloud body would make the preview offer local/cloud on an entity the
    // remote deleted, so the tombstone is surfaced as an absent body and the payload stays
    // reachable through `revisions`/`restoreBody` for a restore.
    const tombstone = head.state === 'deleted' || head.state === 'purged';
    // The remote names its own operation IDs, so one can be `__proto__`. A Map keeps that an
    // ordinary entry instead of reaching the prototype setter, and `Object.fromEntries` turns it
    // into an own property of the reported record.
    const revisions = new Map<string, EntityBody | null>();
    for (const operationId of [...new Set([...head.history, ...(head.current === null ? [] : [head.current])])]) {
      const revision = await session.read(revisionKey(objectId, operationId), signal);
      // A live head's current revision must exist — reconciliation calls its absence invalid data.
      // Reporting the object as bodiless instead would let the preview offer a local publication
      // over the corrupted head. Older history may legitimately be gone, and so may a tombstone's.
      if (revision.kind === 'absent') {
        if (operationId === head.current && !tombstone) throw new SyncPreviewError('not-connected');
        continue;
      }
      const record = decodeRevision(revision.value);
      // A record stored under one operation key while naming another is corrupt however it got there.
      if (record.objectId !== objectId || record.operationId !== operationId)
        throw new SyncPreviewError('not-connected');
      if (record.state === 'payload') {
        if (record.body.kind !== head.kind || record.body.logicalKey !== head.logicalKey)
          throw new SyncPreviewError('not-connected');
        // Reconciliation rejects a live current revision whose epoch is not the head's. Accepting it
        // here would let a reviewed Apply install a body and adopt its baseline behind the engine's
        // corruption check. Retained history legitimately predates the current epoch.
        if (operationId === head.current && record.epoch !== head.epoch) throw new SyncPreviewError('not-connected');
        revisions.set(operationId, record.body);
      } else revisions.set(operationId, null);
    }
    if (head.current !== null) {
      body = revisions.get(head.current) ?? null;
    }
    result.push({
      objectId,
      logicalKey: head.logicalKey,
      kind: head.kind,
      epoch: head.epoch,
      version: value.version,
      revision: head.current,
      body: tombstone ? null : body,
      tombstone,
      revisions: Object.fromEntries(revisions),
      restoreBody:
        body ?? [...revisions.values()].reverse().find((revision): revision is EntityBody => revision !== null),
    });
  }
  return result;
}

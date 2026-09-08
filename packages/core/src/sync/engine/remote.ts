import { SyncBackendError, type SyncSession } from '@aio-proxy/plugin-sdk';

import {
  decodeHead,
  decodeRevision,
  entityKey,
  revisionKey,
  SyncProtocolError,
  type EntityBody,
  type EntityHead,
  type RevisionRecord,
} from '../protocol';
import type { LocalEntity, SyncRepository } from '../repository';
import type { LocalSyncPort, PendingReason } from './incoming';

export interface RemoteReconcileInput {
  readonly bindingId: string;
  readonly session: SyncSession;
  readonly repo: SyncRepository;
  readonly local: LocalSyncPort;
  readonly assertGeneration: (generation: number) => void;
}

function pendingFromError(error: unknown): PendingReason | undefined {
  if (error instanceof SyncProtocolError && error.code === 'upgrade-required') return 'upgrade-required';
  if (error instanceof SyncProtocolError && error.code === 'invalid-data') return 'invalid-config';
  return undefined;
}

function decodeHeadForKey(value: Uint8Array, objectId: string): EntityHead {
  const head = decodeHead(value);
  if (head.objectId !== objectId) throw new SyncProtocolError('invalid-data', 'head object identity mismatch');
  return head;
}

function upsertEntity(
  input: RemoteReconcileInput,
  existing: LocalEntity | undefined,
  head: EntityHead,
  body: EntityBody | null,
  mode: LocalEntity['mode'],
  pendingReason: string | null,
  baseline: string | null,
): void {
  input.repo.putEntity(input.bindingId, {
    objectId: head.objectId,
    logicalKey: head.logicalKey,
    kind: head.kind,
    mode,
    epoch: head.epoch,
    desired: body,
    baseline,
    overrides: existing?.overrides ?? [],
    pendingReason,
    oauth: existing?.oauth,
  });
}

async function readCurrent(
  head: EntityHead,
  session: SyncSession,
  signal: AbortSignal,
): Promise<RevisionRecord | null> {
  const operationId = head.current;
  if (operationId === null) return null;
  const value = await session.read(revisionKey(head.objectId, operationId), signal);
  if (value.kind === 'absent') throw new SyncProtocolError('invalid-data', 'current revision is missing');
  const record = decodeRevision(value.value);
  if (
    record.protocol !== 1 ||
    record.objectId !== head.objectId ||
    record.operationId !== operationId ||
    record.epoch !== head.epoch ||
    record.state !== 'payload'
  ) {
    throw new SyncProtocolError('invalid-data', 'current revision identity mismatch');
  }
  if (record.body.kind !== head.kind || record.body.logicalKey !== head.logicalKey) {
    throw new SyncProtocolError('invalid-data', 'current revision logical identity mismatch');
  }
  return record;
}

// eslint-disable-next-line max-lines-per-function
export async function reconcileRemote(
  input: RemoteReconcileInput,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  const conflictObjects = new Set<string>();
  const identities = new Map<string, Set<string>>();
  let discoveryCursor: string | undefined;
  do {
    const page = await input.session.list(
      { prefix: 's/v1/default/entity/', ...(discoveryCursor === undefined ? {} : { cursor: discoveryCursor }) },
      signal,
    );
    for (const key of page.keys) {
      const objectId = key.slice('s/v1/default/entity/'.length);
      if (objectId.length === 0) continue;
      const value = await input.session.read(entityKey(objectId), signal);
      if (value.kind === 'absent') continue;
      try {
        const head = decodeHeadForKey(value.value, objectId);
        if (head.state === 'active' && head.current !== null) {
          const identity = `${head.kind}\0${head.logicalKey}`;
          const members = identities.get(identity) ?? new Set<string>();
          members.add(objectId);
          identities.set(identity, members);
        }
      } catch {
        // The main pass preserves malformed/unknown records as read-only.
      }
    }
    discoveryCursor = page.nextCursor;
  } while (discoveryCursor !== undefined);
  for (const members of identities.values()) {
    if (members.size > 1) for (const objectId of members) conflictObjects.add(objectId);
  }

  let cursor: string | undefined;
  const known = new Map(input.repo.entities(input.bindingId).map((entity) => [entity.objectId, entity]));
  do {
    const page = await input.session.list(
      { prefix: 's/v1/default/entity/', ...(cursor === undefined ? {} : { cursor }) },
      signal,
    );
    for (const key of page.keys) {
      signal.throwIfAborted();
      const objectId = key.slice('s/v1/default/entity/'.length);
      if (objectId.length === 0) continue;
      let head: EntityHead;
      try {
        const value = await input.session.read(entityKey(objectId), signal);
        if (value.kind === 'absent') continue;
        head = decodeHeadForKey(value.value, objectId);
      } catch (error) {
        if (error instanceof SyncBackendError) throw error;
        const existing = known.get(objectId);
        if (existing !== undefined) {
          input.assertGeneration(generation);
          upsertEntity(
            input,
            existing,
            {
              protocol: 1,
              objectId,
              kind: existing.kind,
              logicalKey: existing.logicalKey,
              epoch: existing.epoch,
              sequence: 0,
              state: 'active',
              current: null,
              history: [],
              reserved: [],
              cancelling: [],
              receipts: {},
              cleanupComplete: true,
            },
            existing.desired,
            existing.mode,
            pendingFromError(error) ?? 'upgrade-required',
            existing.baseline,
          );
        }
        continue;
      }
      const existing = known.get(objectId);
      const conflicting = [...known.values()].find(
        (candidate) =>
          candidate.objectId !== objectId && candidate.kind === head.kind && candidate.logicalKey === head.logicalKey,
      );
      if (head.state !== 'active') {
        if (existing !== undefined) {
          input.assertGeneration(generation);
          await input.local.applyRemote(objectId, null, `deleted:${head.epoch}`);
          input.assertGeneration(generation);
        }
        input.assertGeneration(generation);
        upsertEntity(input, existing, head, null, existing?.mode ?? 'excluded', null, `deleted:${head.epoch}`);
        known.set(objectId, {
          ...existing,
          objectId,
          logicalKey: head.logicalKey,
          kind: head.kind,
          mode: existing?.mode ?? 'excluded',
          epoch: head.epoch,
          desired: null,
          baseline: `deleted:${head.epoch}`,
          overrides: existing?.overrides ?? [],
          pendingReason: null,
        });
        continue;
      }
      if (head.current === null) continue;
      let record: RevisionRecord | null;
      try {
        record = await readCurrent(head, input.session, signal);
      } catch (error) {
        if (error instanceof SyncBackendError) throw error;
        const reason = pendingFromError(error);
        if (existing !== undefined && reason !== undefined) {
          input.assertGeneration(generation);
          upsertEntity(input, existing, head, existing.desired, existing.mode, reason, existing.baseline);
        }
        continue;
      }
      if (record === null || record.state !== 'payload') continue;
      const body = record.body;
      if (conflictObjects.has(objectId) || conflicting !== undefined) {
        const candidates = [...known.values(), ...(existing === undefined ? [] : [existing])].filter(
          (candidate, index, all) =>
            candidate.kind === head.kind &&
            candidate.logicalKey === head.logicalKey &&
            all.findIndex((item) => item.objectId === candidate.objectId) === index,
        );
        for (const candidate of candidates) {
          if (candidate.mode === 'included') {
            input.assertGeneration(generation);
            await input.local.applyRemote(candidate.objectId, null, `conflict:${head.epoch}`);
            input.assertGeneration(generation);
          }
          input.assertGeneration(generation);
          input.repo.putEntity(input.bindingId, {
            ...candidate,
            mode: 'excluded',
            pendingReason: 'provider-id-conflict',
          });
          known.set(candidate.objectId, { ...candidate, mode: 'excluded', pendingReason: 'provider-id-conflict' });
        }
        input.assertGeneration(generation);
        upsertEntity(input, existing, head, body, 'excluded', 'provider-id-conflict', existing?.baseline ?? null);
        known.set(objectId, {
          ...existing,
          objectId,
          logicalKey: head.logicalKey,
          kind: head.kind,
          mode: 'excluded',
          epoch: head.epoch,
          desired: body,
          baseline: existing?.baseline ?? null,
          overrides: existing?.overrides ?? [],
          pendingReason: 'provider-id-conflict',
        });
        continue;
      }
      const mode = existing?.mode ?? 'included';
      if (mode === 'excluded') {
        input.assertGeneration(generation);
        upsertEntity(input, existing, head, body, mode, null, record.operationId);
        known.set(objectId, {
          ...existing,
          objectId,
          logicalKey: head.logicalKey,
          kind: head.kind,
          mode,
          epoch: head.epoch,
          desired: body,
          baseline: record.operationId,
          overrides: existing?.overrides ?? [],
          pendingReason: null,
        });
        continue;
      }
      if (existing?.baseline === record.operationId && existing.pendingReason === null) continue;
      let activation;
      try {
        input.assertGeneration(generation);
        if (input.local.checkRemote === undefined) {
          activation = await input.local.applyRemote(objectId, body, record.operationId);
        } else {
          const pending = await input.local.checkRemote(body);
          input.assertGeneration(generation);
          activation =
            pending === undefined
              ? await input.local.applyRemote(objectId, body, record.operationId)
              : { applied: false, pending };
        }
        input.assertGeneration(generation);
      } catch (error) {
        const reason = pendingFromError(error);
        if (reason === undefined) throw error;
        input.assertGeneration(generation);
        activation = { applied: false, pending: reason };
      }
      const pending = activation.applied ? null : (activation.pending ?? 'invalid-config');
      upsertEntity(
        input,
        existing,
        head,
        body,
        mode,
        pending,
        activation.applied ? record.operationId : (existing?.baseline ?? null),
      );
      known.set(objectId, {
        ...existing,
        objectId,
        logicalKey: head.logicalKey,
        kind: head.kind,
        mode,
        epoch: head.epoch,
        desired: body,
        baseline: activation.applied ? record.operationId : (existing?.baseline ?? null),
        overrides: existing?.overrides ?? [],
        pendingReason: pending,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

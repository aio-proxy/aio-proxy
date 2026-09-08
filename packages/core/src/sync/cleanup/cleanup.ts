import { SyncBackendError } from '@aio-proxy/plugin-sdk';

import {
  accountKey,
  decodeRevision,
  encode,
  entityKey,
  revisionKey,
  SyncProtocolError,
  type DeletedAccount,
  type EntityBody,
  type EntityHead,
  type RevisionRecord,
} from '../protocol';
import { finalizeReceipt, publishEntity, type PublishedRevision, type SyncObjectStore } from '../publication';
import type { OutboxOperation } from '../repository';

const SPACE_KEY = 's/v1/default/space';

export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertSize(store: SyncObjectStore, bytes: Uint8Array): void {
  if (bytes.byteLength > store.session.maxValueBytes) {
    throw new SyncBackendError('quota', 'sync object exceeds backend limit');
  }
}

export async function readHeadOrThrow(
  store: SyncObjectStore,
  objectId: string,
  signal: AbortSignal,
): Promise<{ head: EntityHead; version: string; modifiedAt: number }> {
  const current = await store.readHead(objectId, signal);
  if (current === null) throw new SyncProtocolError('invalid-data', 'missing head');
  return current;
}

export async function updateHead(
  store: SyncObjectStore,
  objectId: string,
  change: (head: EntityHead) => EntityHead,
  signal: AbortSignal,
): Promise<{ head: EntityHead; version: string; modifiedAt: number }> {
  for (;;) {
    signal.throwIfAborted();
    const current = await readHeadOrThrow(store, objectId, signal);
    const next = change(current.head);
    if (next === current.head) return current;
    const bytes = encode(next);
    assertSize(store, bytes);
    try {
      const result = await store.session.compareAndSwap(entityKey(objectId), current.version, bytes, signal);
      if (result.kind === 'written') return { head: next, version: result.version, modifiedAt: result.modifiedAt };
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') continue;
      throw error;
    }
  }
}

export function revisionIdentity(
  objectId: string,
  operationId: string,
  epoch: number,
): { objectId: string; operationId: string; epoch: number } {
  return { objectId, operationId, epoch };
}

function assertRevisionIdentity(
  record: RevisionRecord,
  identity: { objectId: string; operationId: string; epoch?: number },
): void {
  if (
    record.objectId !== identity.objectId ||
    record.operationId !== identity.operationId ||
    (identity.epoch !== undefined && record.epoch !== identity.epoch)
  ) {
    throw new SyncProtocolError('invalid-data', 'revision identity mismatch');
  }
}

export async function finalizeRevisionReceiptIfPresent(
  store: SyncObjectStore,
  head: EntityHead,
  operationId: string,
  signal: AbortSignal,
): Promise<RevisionRecord | null> {
  const value = await store.session.read(revisionKey(head.objectId, operationId), signal);
  if (value.kind === 'absent') return null;
  const record = decodeRevision(value.value);
  assertRevisionIdentity(record, { objectId: head.objectId, operationId, epoch: record.epoch });
  if (head.receipts[operationId] !== undefined && record.state === 'payload') {
    await finalizeReceiptRecoverable(store, head, operationId, signal);
    const refreshed = await store.session.read(revisionKey(head.objectId, operationId), signal);
    if (refreshed.kind === 'absent') throw new SyncProtocolError('invalid-data', 'publication receipt has no revision');
    return decodeRevision(refreshed.value);
  }
  return record;
}

async function finalizeReceiptRecoverable(
  store: SyncObjectStore,
  head: EntityHead,
  operationId: string,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    try {
      await finalizeReceipt(store, head, operationId, signal);
      return;
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') continue;
      throw error;
    }
  }
}

function markerFor(
  objectId: string,
  operationId: string,
  epoch: number,
  publishedSequence: number | null,
  reason: 'expired' | 'purged' | 'abandoned',
): RevisionRecord {
  return {
    protocol: 1,
    state: 'erased',
    objectId,
    epoch,
    operationId,
    publishedSequence,
    reason,
  };
}

export async function eraseRevision(
  store: SyncObjectStore,
  key: string,
  marker: RevisionRecord,
  signal: AbortSignal,
): Promise<void> {
  assertSize(store, encode(marker));
  for (;;) {
    signal.throwIfAborted();
    const current = await store.session.read(key, signal);
    if (current.kind === 'present') {
      const record = decodeRevision(current.value);
      assertRevisionIdentity(record, marker);
      if (record.state === 'erased') {
        if (record.publishedSequence !== marker.publishedSequence) {
          throw new SyncProtocolError('invalid-data', 'erased publication receipt sequence mismatch');
        }
        return;
      }
      const next = {
        ...marker,
        publishedSequence: record.publishedSequence ?? marker.publishedSequence,
      } satisfies RevisionRecord;
      try {
        const result = await store.session.compareAndSwap(key, current.version, encode(next), signal);
        if (result.kind === 'written') return;
      } catch (error) {
        if (error instanceof SyncBackendError && error.code === 'outcome-unknown') continue;
        throw error;
      }
      continue;
    }
    try {
      const result = await store.session.compareAndSwap(key, null, encode(marker), signal);
      if (result.kind === 'written') return;
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') continue;
      throw error;
    }
  }
}

export function revisionMarker(
  objectId: string,
  operationId: string,
  epoch: number,
  publishedSequence: number | undefined,
  reason: 'expired' | 'purged' | 'abandoned',
): RevisionRecord {
  return markerFor(objectId, operationId, epoch, publishedSequence ?? null, reason);
}

export async function ensureAccountTombstone(
  store: SyncObjectStore,
  objectId: string,
  epoch: number,
  signal: AbortSignal,
): Promise<void> {
  const marker: DeletedAccount = { protocol: 1, phase: 'deleted', objectId, epoch };
  const bytes = encode(marker);
  assertSize(store, bytes);
  const key = accountKey(objectId);
  for (;;) {
    signal.throwIfAborted();
    const current = await store.session.read(key, signal);
    if (current.kind === 'present' && sameBytes(current.value, bytes)) return;
    try {
      const result = await store.session.compareAndSwap(
        key,
        current.kind === 'absent' ? null : current.version,
        bytes,
        signal,
      );
      if (result.kind === 'written') return;
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') continue;
      throw error;
    }
  }
}

export function frozenRevisionIds(head: EntityHead): string[] {
  return [
    ...new Set([
      ...(head.current === null ? [] : [head.current]),
      ...head.history,
      ...head.reserved,
      ...head.cancelling,
      ...Object.keys(head.receipts),
    ]),
  ];
}

export async function deleteEntity(
  store: SyncObjectStore,
  objectId: string,
  epoch: number,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const current = await readHeadOrThrow(store, objectId, signal);
    if (current.head.epoch !== epoch) throw new SyncProtocolError('epoch-mismatch', 'epoch-mismatch');
    if (current.head.state === 'purging' || current.head.state === 'purged') {
      throw new SyncProtocolError('deleted', 'deleted');
    }
    if (current.head.state === 'active') {
      await updateHead(
        store,
        objectId,
        (head) => ({
          ...head,
          state: 'deleted',
          cleanupComplete: false,
          cancelling: [...new Set([...head.cancelling, ...head.reserved])],
        }),
        signal,
      );
      continue;
    }
    break;
  }

  const deleted = await readHeadOrThrow(store, objectId, signal);
  await ensureAccountTombstone(store, objectId, deleted.head.epoch, signal);

  for (;;) {
    const current = await readHeadOrThrow(store, objectId, signal);
    if (current.head.state !== 'deleted') throw new SyncProtocolError('deleted', 'deleted');
    const pending = [...new Set([...current.head.reserved, ...current.head.cancelling])];
    if (pending.length === 0) {
      await updateHead(
        store,
        objectId,
        (head) => (head.state === 'deleted' ? { ...head, cleanupComplete: true } : head),
        signal,
      );
      return;
    }
    await updateHead(
      store,
      objectId,
      (head) => ({ ...head, cancelling: [...new Set([...head.cancelling, ...head.reserved])] }),
      signal,
    );
    const frozen = await readHeadOrThrow(store, objectId, signal);
    const ids = [...new Set([...frozen.head.reserved, ...frozen.head.cancelling])];
    for (const operationId of ids) {
      const record = await finalizeRevisionReceiptIfPresent(store, frozen.head, operationId, signal);
      const sequence = frozen.head.receipts[operationId] ?? record?.publishedSequence ?? undefined;
      await eraseRevision(
        store,
        revisionKey(objectId, operationId),
        revisionMarker(objectId, operationId, frozen.head.epoch, sequence, 'abandoned'),
        signal,
      );
      await updateHead(
        store,
        objectId,
        (head) => ({
          ...head,
          reserved: head.reserved.filter((id) => id !== operationId),
          cancelling: head.cancelling.filter((id) => id !== operationId),
        }),
        signal,
      );
    }
  }
}

export async function readServerTime(store: SyncObjectStore, signal: AbortSignal): Promise<number> {
  const nonceBytes = encode({ protocol: 1, nonce: crypto.randomUUID() });
  assertSize(store, nonceBytes);
  for (;;) {
    signal.throwIfAborted();
    const current = await store.session.read(SPACE_KEY, signal);
    try {
      const result = await store.session.compareAndSwap(
        SPACE_KEY,
        current.kind === 'absent' ? null : current.version,
        nonceBytes,
        signal,
      );
      if (result.kind === 'written') return result.modifiedAt;
    } catch (error) {
      if (!(error instanceof SyncBackendError) || error.code !== 'outcome-unknown') throw error;
      const confirmed = await store.session.read(SPACE_KEY, signal);
      if (confirmed.kind === 'present' && sameBytes(confirmed.value, nonceBytes)) return confirmed.modifiedAt;
    }
  }
}

// Kept as a compatibility export for cleanup callers that use the task-local module.
export { purgeEntity } from './purge';
export { collectHistory } from './history';

export async function restoreEntity(
  store: SyncObjectStore,
  objectId: string,
  body: EntityBody,
  operationId: string,
  signal: AbortSignal,
): Promise<PublishedRevision> {
  for (;;) {
    const current = await readHeadOrThrow(store, objectId, signal);
    if (current.head.kind !== body.kind || current.head.logicalKey !== body.logicalKey) {
      throw new SyncProtocolError('invalid-data', 'head logical identity mismatch');
    }
    if (current.head.state === 'active') {
      if (
        !current.head.receipts[operationId] &&
        !current.head.reserved.includes(operationId) &&
        current.head.current !== operationId &&
        !current.head.history.includes(operationId)
      ) {
        throw new SyncProtocolError('invalid-data', 'restore requires deleted or purged head');
      }
      const operation: OutboxOperation = {
        operationId,
        objectId,
        epoch: current.head.epoch,
        kind: 'put',
        commitId: `restore:${operationId}`,
        body,
      };
      return publishEntity(store, operation, signal);
    }
    if (!current.head.cleanupComplete) throw new SyncProtocolError('deleted', 'deletion cleanup is incomplete');
    if (current.head.state !== 'deleted' && current.head.state !== 'purged') {
      throw new SyncProtocolError('deleted', 'deleted');
    }
    const restored = await updateHead(
      store,
      objectId,
      (head) => {
        if (head.state !== 'deleted' && head.state !== 'purged') return head;
        return {
          ...head,
          epoch: head.epoch + 1,
          state: 'active',
          current: null,
          history: head.current === null ? head.history : [...new Set([...head.history, head.current])],
          reserved: [],
          cancelling: [],
          cleanupComplete: true,
        };
      },
      signal,
    );
    const operation: OutboxOperation = {
      operationId,
      objectId,
      epoch: restored.head.epoch,
      kind: 'put',
      commitId: `restore:${operationId}`,
      body,
    };
    return publishEntity(store, operation, signal);
  }
}

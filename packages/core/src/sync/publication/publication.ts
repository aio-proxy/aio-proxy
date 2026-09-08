import { SyncBackendError, type SyncSession } from '@aio-proxy/plugin-sdk';

import {
  decodeHead,
  decodeRevision,
  encode,
  entityKey,
  newHead,
  publish,
  reserve,
  revisionKey,
  SyncProtocolError,
  type EntityHead,
  type RevisionRecord,
} from '../protocol';
import type { OutboxOperation } from '../repository';
import { finalizeReceipt } from './receipts';

export { finalizeReceipt };

export interface PublishedRevision {
  operationId: string;
  sequence: number;
}

export interface SyncObjectStore {
  session: SyncSession;
  readHead(
    objectId: string,
    signal: AbortSignal,
  ): Promise<{ head: EntityHead; version: string; modifiedAt: number } | null>;
}

export function createSyncObjectStore(session: SyncSession): SyncObjectStore {
  return {
    session,
    async readHead(objectId, signal) {
      const value = await session.read(entityKey(objectId), signal);
      if (value.kind === 'absent') return null;
      const head = decodeHead(value.value);
      if (head.objectId !== objectId) throw new SyncProtocolError('invalid-data', 'head object identity mismatch');
      return { head, version: value.version, modifiedAt: value.modifiedAt };
    },
  };
}

type StoredRevision = { record: RevisionRecord; version: string; modifiedAt: number };

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPut(
  operation: OutboxOperation,
): asserts operation is OutboxOperation & { kind: 'put'; body: NonNullable<OutboxOperation['body']> } {
  if (operation.kind !== 'put' || operation.body === null) {
    throw new SyncProtocolError('invalid-data', 'publication only accepts put operations');
  }
}

function assertHeadIdentity(head: EntityHead, operation: OutboxOperation): void {
  if (head.objectId !== operation.objectId)
    throw new SyncProtocolError('invalid-data', 'head object identity mismatch');
  if (head.kind !== operation.body?.kind || head.logicalKey !== operation.body?.logicalKey) {
    throw new SyncProtocolError('invalid-data', 'head logical identity mismatch');
  }
}

function assertRevision(record: RevisionRecord, operation: OutboxOperation): void {
  assertPut(operation);
  if (
    record.objectId !== operation.objectId ||
    record.operationId !== operation.operationId ||
    record.epoch !== operation.epoch
  ) {
    throw new SyncProtocolError('invalid-data', 'revision identity mismatch');
  }
  if (record.state === 'payload') {
    if (!sameJson(record.body, operation.body))
      throw new SyncProtocolError('invalid-data', 'revision payload mismatch');
    return;
  }
  if (record.publishedSequence === null) {
    throw new SyncProtocolError('deleted', `operation has been ${record.reason}`);
  }
}

function assertSize(store: SyncObjectStore, bytes: Uint8Array): void {
  if (bytes.byteLength > store.session.maxValueBytes) {
    throw new SyncBackendError('quota', 'sync object exceeds backend limit');
  }
}

async function readRevision(
  store: SyncObjectStore,
  operation: OutboxOperation,
  signal: AbortSignal,
): Promise<StoredRevision | null> {
  const value = await store.session.read(revisionKey(operation.objectId, operation.operationId), signal);
  if (value.kind === 'absent') return null;
  const record = decodeRevision(value.value);
  assertRevision(record, operation);
  return { record, version: value.version, modifiedAt: value.modifiedAt };
}

async function casHead(
  store: SyncObjectStore,
  objectId: string,
  change: (head: EntityHead) => EntityHead,
  signal: AbortSignal,
): Promise<{ head: EntityHead; modifiedAt: number }> {
  for (;;) {
    signal.throwIfAborted();
    const current = await store.readHead(objectId, signal);
    if (current === null) throw new SyncProtocolError('invalid-data', 'missing head');
    const next = change(current.head);
    if (next === current.head) return { head: current.head, modifiedAt: current.modifiedAt };
    const bytes = encode(next);
    assertSize(store, bytes);
    const result = await store.session.compareAndSwap(entityKey(objectId), current.version, bytes, signal);
    if (result.kind === 'written') return { head: next, modifiedAt: result.modifiedAt };
  }
}

async function ensureHead(store: SyncObjectStore, operation: OutboxOperation, signal: AbortSignal): Promise<void> {
  assertPut(operation);
  for (;;) {
    signal.throwIfAborted();
    const current = await store.readHead(operation.objectId, signal);
    if (current !== null) {
      assertHeadIdentity(current.head, operation);
      return;
    }
    const next = newHead(operation.objectId, operation.body);
    const bytes = encode(next);
    assertSize(store, bytes);
    const result = await store.session.compareAndSwap(entityKey(operation.objectId), null, bytes, signal);
    if (result.kind === 'written') return;
  }
}

async function existingReceipt(
  store: SyncObjectStore,
  head: EntityHead,
  operation: OutboxOperation,
  signal: AbortSignal,
): Promise<PublishedRevision | undefined> {
  const sequence = head.receipts[operation.operationId];
  if (sequence === undefined) return undefined;
  const revision = await readRevision(store, operation, signal);
  if (revision === null) throw new SyncProtocolError('invalid-data', 'publication receipt has no revision');
  if (revision.record.state === 'payload') {
    if (revision.record.publishedSequence !== null && revision.record.publishedSequence !== sequence) {
      throw new SyncProtocolError('invalid-data', 'publication receipt sequence mismatch');
    }
  } else if (revision.record.publishedSequence !== sequence) {
    throw new SyncProtocolError('invalid-data', 'erased publication receipt sequence mismatch');
  }
  return { operationId: operation.operationId, sequence };
}

function storedPublication(revision: StoredRevision | null, operationId: string): PublishedRevision | undefined {
  if (revision === null || revision.record.publishedSequence === null) return undefined;
  return { operationId, sequence: revision.record.publishedSequence };
}

async function ensurePayload(
  store: SyncObjectStore,
  operation: OutboxOperation,
  signal: AbortSignal,
): Promise<StoredRevision> {
  assertPut(operation);
  const bytes = encode({
    protocol: 1,
    state: 'payload',
    objectId: operation.objectId,
    epoch: operation.epoch,
    operationId: operation.operationId,
    body: operation.body,
    publishedSequence: null,
    writtenAt: null,
  });
  assertSize(store, bytes);
  for (;;) {
    signal.throwIfAborted();
    const current = await readRevision(store, operation, signal);
    if (current !== null) return current;
    const result = await store.session.compareAndSwap(
      revisionKey(operation.objectId, operation.operationId),
      null,
      bytes,
      signal,
    );
    if (result.kind === 'written') {
      return {
        record: decodeRevision(bytes),
        version: result.version,
        modifiedAt: result.modifiedAt,
      };
    }
  }
}

async function publishReserved(
  store: SyncObjectStore,
  operation: OutboxOperation,
  signal: AbortSignal,
): Promise<{ head: EntityHead; modifiedAt: number; sequence: number }> {
  assertPut(operation);
  for (;;) {
    signal.throwIfAborted();
    const current = await store.readHead(operation.objectId, signal);
    if (current === null) throw new SyncProtocolError('invalid-data', 'missing head');
    assertHeadIdentity(current.head, operation);
    const receipt = await existingReceipt(store, current.head, operation, signal);
    if (receipt !== undefined)
      return { head: current.head, modifiedAt: current.modifiedAt, sequence: receipt.sequence };

    const revision = await readRevision(store, operation, signal);
    const previousPublication = storedPublication(revision, operation.operationId);
    if (previousPublication !== undefined)
      return { head: current.head, modifiedAt: current.modifiedAt, sequence: previousPublication.sequence };
    if (revision === null || revision.record.state !== 'payload') {
      throw new SyncProtocolError('invalid-data', 'publication payload is missing');
    }
    if (revision.record.publishedSequence !== null) {
      throw new SyncProtocolError('invalid-data', 'publication receipt is not attached to the head');
    }
    if (!current.head.reserved.includes(operation.operationId)) {
      throw new SyncProtocolError('invalid-data', 'operation was not reserved');
    }
    const next = publish(current.head, operation.operationId, operation.epoch);
    const bytes = encode(next);
    assertSize(store, bytes);
    const result = await store.session.compareAndSwap(entityKey(operation.objectId), current.version, bytes, signal);
    if (result.kind === 'written')
      return { head: next, modifiedAt: result.modifiedAt, sequence: next.receipts[operation.operationId]! };
  }
}

export async function publishEntity(
  store: SyncObjectStore,
  operation: OutboxOperation,
  signal: AbortSignal,
): Promise<PublishedRevision> {
  assertPut(operation);
  await ensureHead(store, operation, signal);
  for (;;) {
    signal.throwIfAborted();
    const current = await store.readHead(operation.objectId, signal);
    if (current === null) throw new SyncProtocolError('invalid-data', 'missing head');
    assertHeadIdentity(current.head, operation);
    const receipt = await existingReceipt(store, current.head, operation, signal);
    if (receipt !== undefined) {
      await finalizeReceipt(store, current.head, operation.operationId, signal);
      return receipt;
    }
    const revision = await readRevision(store, operation, signal);
    const previousPublication = storedPublication(revision, operation.operationId);
    if (previousPublication !== undefined) return previousPublication;
    await casHead(
      store,
      operation.objectId,
      (head) => {
        assertHeadIdentity(head, operation);
        return reserve(head, operation.operationId, operation.epoch);
      },
      signal,
    );
    const payload = await ensurePayload(store, operation, signal);
    if (payload.record.state !== 'payload')
      throw new SyncProtocolError('invalid-data', 'publication payload is missing');
    const published = await publishReserved(store, operation, signal);
    await finalizeReceipt(store, published.head, operation.operationId, signal);
    return { operationId: operation.operationId, sequence: published.sequence };
  }
}

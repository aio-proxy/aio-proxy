import { SyncBackendError, type SyncSession } from '@aio-proxy/plugin-sdk';
import { isEqual } from 'es-toolkit/predicate';

import {
  decodeHead,
  decodeRevision,
  encode,
  entityKey,
  newHead,
  publish,
  receiptSequence,
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
    if (!isEqual(record.body, operation.body)) throw new SyncProtocolError('invalid-data', 'revision payload mismatch');
    return;
  }
  if (record.publishedSequence === null) {
    throw new SyncProtocolError('deleted', `operation has been ${record.reason}`);
  }
}

export function assertSize(store: SyncObjectStore, bytes: Uint8Array): void {
  if (bytes.byteLength > store.session.maxValueBytes) {
    throw new SyncBackendError('quota', 'sync object exceeds backend limit');
  }
}

/**
 * The encoded body alone is over the backend's limit, so `publishEntity` can only ever throw
 * `quota` for this operation. Callers use it to tell that permanent condition apart from a
 * transient `quota` the backend itself raises, which retrying does resolve.
 */
export function exceedsValueLimit(store: SyncObjectStore, operation: OutboxOperation): boolean {
  if (operation.kind !== 'put' || operation.body === null) return false;
  return encodePayload(operation).byteLength > store.session.maxValueBytes;
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

// The same stranding as below, but where the reread finds a head another device has moved on from:
// the fence has to fail, so the reservation cannot be consumed in place and is handed to `cancelling`
// for routine cleanup instead.
// ponytail: bounded retries, best effort — a lost race leaves the entry for the next attempt, and
// this must never mask the `upgrade-required` the caller has to see.
async function cancelStrandedReservation(
  store: SyncObjectStore,
  objectId: string,
  operationId: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.readHead(objectId, signal);
    if (current === null || !current.head.reserved.includes(operationId)) return;
    const next: EntityHead = {
      ...current.head,
      reserved: current.head.reserved.filter((id) => id !== operationId),
      cancelling: [...new Set([...current.head.cancelling, operationId])],
    };
    const result = await store.session.compareAndSwap(entityKey(objectId), current.version, encode(next), signal);
    if (result.kind === 'written') return;
  }
}

async function casHead(
  store: SyncObjectStore,
  objectId: string,
  change: (head: EntityHead) => EntityHead,
  signal: AbortSignal,
  expectedVersion?: string,
  reservationId?: string,
): Promise<{ head: EntityHead; modifiedAt: number }> {
  // An unknown outcome that actually committed strands the reservation it wrote: control-plane
  // publications mint a fresh operation ID per attempt, so nothing ever retries that one, and
  // maintenance only reclaims a reservation whose payload revision exists — this one has none.
  // The head would keep the dead entry until repeated attempts exhaust its size limit. Recognizing
  // our own transition on the reread consumes the reservation in place; a write that never landed
  // just retries, since reserving is idempotent per operation ID.
  let attempted: EntityHead | undefined;
  for (;;) {
    signal.throwIfAborted();
    const current = await store.readHead(objectId, signal);
    if (current === null) throw new SyncProtocolError('invalid-data', 'missing head');
    if (attempted !== undefined && isEqual(current.head, attempted))
      return { head: current.head, modifiedAt: current.modifiedAt };
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      if (attempted !== undefined && reservationId !== undefined) {
        await cancelStrandedReservation(store, objectId, reservationId, signal);
      }
      throw new SyncProtocolError('upgrade-required', 'head version changed');
    }
    const next = change(current.head);
    if (next === current.head) return { head: current.head, modifiedAt: current.modifiedAt };
    const bytes = encode(next);
    assertSize(store, bytes);
    try {
      const result = await store.session.compareAndSwap(entityKey(objectId), current.version, bytes, signal);
      if (result.kind === 'written') return { head: next, modifiedAt: result.modifiedAt };
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') {
        attempted = next;
        continue;
      }
      throw error;
    }
  }
}

async function ensureHead(
  store: SyncObjectStore,
  operation: OutboxOperation,
  signal: AbortSignal,
): Promise<{ readonly version: string; readonly created: boolean }> {
  assertPut(operation);
  let attempted: EntityHead | undefined;
  for (;;) {
    signal.throwIfAborted();
    const current = await store.readHead(operation.objectId, signal);
    if (current !== null) {
      assertHeadIdentity(current.head, operation);
      // An uncertain write is recoverable by read, so a head identical to the one this call just
      // attempted is that write landing. Reporting it as someone else's head would fail a
      // create-only publish with `upgrade-required` and strand an active head with no revision.
      return { version: current.version, created: attempted !== undefined && isEqual(current.head, attempted) };
    }
    const next = newHead(operation.objectId, operation.body);
    const bytes = encode(next);
    assertSize(store, bytes);
    try {
      const result = await store.session.compareAndSwap(entityKey(operation.objectId), null, bytes, signal);
      if (result.kind === 'written') return { version: result.version, created: true };
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') {
        attempted = next;
        continue;
      }
      throw error;
    }
  }
}

async function existingReceipt(
  store: SyncObjectStore,
  head: EntityHead,
  operation: OutboxOperation,
  signal: AbortSignal,
): Promise<PublishedRevision | undefined> {
  const sequence = receiptSequence(head, operation.operationId);
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

function encodePayload(operation: OutboxOperation): Uint8Array {
  assertPut(operation);
  return encode({
    protocol: 1,
    state: 'payload',
    objectId: operation.objectId,
    epoch: operation.epoch,
    operationId: operation.operationId,
    body: operation.body,
    publishedSequence: null,
    writtenAt: null,
  });
}

async function ensurePayload(
  store: SyncObjectStore,
  operation: OutboxOperation,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<StoredRevision> {
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
  expectedSequence?: number,
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
    // Reserving is fenced, but publishing is what makes this body current, and the two are separated
    // by a payload write. Another device that reserves and publishes in that window leaves the head's
    // version changed and its sequence bumped; retrying against the latest head would then make a
    // reviewed-but-stale body current last and report success, silently overwriting a revision the
    // preview never showed. Only `publish()` moves the sequence, so it is the whole fence: a
    // competing reservation is harmless and still retries. Checked after the idempotence returns
    // above, so a resumed publication of our own landed write still reports its receipt.
    if (expectedSequence !== undefined && current.head.sequence !== expectedSequence)
      throw new SyncProtocolError('upgrade-required', 'head published a newer revision');
    const next = publish(current.head, operation.operationId, operation.epoch);
    const bytes = encode(next);
    assertSize(store, bytes);
    try {
      const result = await store.session.compareAndSwap(entityKey(operation.objectId), current.version, bytes, signal);
      if (result.kind === 'written')
        return { head: next, modifiedAt: result.modifiedAt, sequence: next.receipts[operation.operationId]! };
    } catch (error) {
      // This CAS is what makes the payload current, so an unknown outcome that actually committed
      // lets every peer activate the change while this device reports failure. `publish()` is the
      // only writer of this receipt and the loop proved it absent above, so seeing it on the reread
      // means the write landed. Control-plane publications mint a fresh operation ID per attempt,
      // unlike outbox retries, so nothing else would ever reconcile the difference.
      if (!(error instanceof SyncBackendError) || error.code !== 'outcome-unknown') throw error;
      const after = await store.readHead(operation.objectId, signal);
      const landed = after === null ? undefined : await existingReceipt(store, after.head, operation, signal);
      if (after === null || landed === undefined) throw error;
      return { head: after.head, modifiedAt: after.modifiedAt, sequence: landed.sequence };
    }
  }
}

export async function publishEntity(
  store: SyncObjectStore,
  operation: OutboxOperation,
  signal: AbortSignal,
  expectedVersion?: string | null,
): Promise<PublishedRevision> {
  assertPut(operation);
  // Maintenance deliberately never reclaims a reservation whose revision is absent, and the
  // immutable oversized outbox entry is retried ahead of everything else on each pass — so
  // reserving first and only then discovering the body is over the backend's limit wedges the
  // binding for good. Size is a property of the encoded body alone, so it is settled up front,
  // before the head is created or touched.
  const payload = encodePayload(operation);
  assertSize(store, payload);
  const ensured = await ensureHead(store, operation, signal);
  if (expectedVersion !== undefined) {
    if (expectedVersion === null && !ensured.created) throw new SyncProtocolError('upgrade-required', 'head exists');
    if (expectedVersion !== null && ensured.version !== expectedVersion)
      throw new SyncProtocolError('upgrade-required', 'head version changed');
  }
  // The fence carries the version this call validated, including the head it just created: between
  // that creation and the reservation another device can publish onto the new head, and reserving
  // unfenced would make a stale local choice current instead of reporting the conflict.
  const firstExpected = expectedVersion === undefined ? undefined : ensured.version;
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
    const reserved = await casHead(
      store,
      operation.objectId,
      (head) => {
        assertHeadIdentity(head, operation);
        return reserve(head, operation.operationId, operation.epoch);
      },
      signal,
      firstExpected,
      operation.operationId,
    );
    const stored = await ensurePayload(store, operation, payload, signal);
    if (stored.record.state !== 'payload')
      throw new SyncProtocolError('invalid-data', 'publication payload is missing');
    const published = await publishReserved(
      store,
      operation,
      signal,
      firstExpected === undefined ? undefined : reserved.head.sequence,
    );
    await finalizeReceipt(store, published.head, operation.operationId, signal);
    return { operationId: operation.operationId, sequence: published.sequence };
  }
}

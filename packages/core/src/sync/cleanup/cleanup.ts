import { SyncBackendError } from '@aio-proxy/plugin-sdk';
import { isEqual } from 'es-toolkit/predicate';

import {
  accountKey,
  decodeRevision,
  encode,
  entityKey,
  revisionKey,
  SyncProtocolError,
  type DeletedAccount,
  type EntityHead,
  type RevisionRecord,
} from '../protocol';
import { finalizeReceipt, type SyncObjectStore } from '../publication';

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
  expectedVersion?: string,
): Promise<{ head: EntityHead; version: string; modifiedAt: number }> {
  // An unknown CAS outcome may already have committed, which moves the version the fence names.
  // Recognizing our own transition on the reread keeps the fence honest without rejecting a write
  // that landed — for a delete that rejection stranded the head at cleanupComplete: false, before
  // the tombstone and reservation cleanup that a later restore depends on.
  let attempted: EntityHead | undefined;
  for (;;) {
    signal.throwIfAborted();
    const current = await readHeadOrThrow(store, objectId, signal);
    if (attempted !== undefined && isEqual(current.head, attempted)) return current;
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw new SyncProtocolError('upgrade-required', 'head version changed');
    const next = change(current.head);
    if (next === current.head) return current;
    const bytes = encode(next);
    assertSize(store, bytes);
    try {
      const result = await store.session.compareAndSwap(entityKey(objectId), current.version, bytes, signal);
      if (result.kind === 'written') return { head: next, version: result.version, modifiedAt: result.modifiedAt };
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') {
        attempted = next;
        continue;
      }
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
    const head = await store.readHead(objectId, signal);
    if (head === null) throw new SyncProtocolError('invalid-data', 'missing head');
    if (head.head.epoch > epoch || (head.head.epoch === epoch && head.head.state === 'active')) return;
    if (head.head.epoch < epoch) throw new SyncProtocolError('epoch-mismatch', 'epoch-mismatch');
    const current = await store.session.read(key, signal);
    if (current.kind === 'present' && sameBytes(current.value, bytes)) return;
    if (current.kind === 'present') {
      const identity = accountIdentity(current.value);
      if (identity !== undefined) {
        if (identity.objectId !== objectId) {
          throw new SyncProtocolError('invalid-data', 'account object identity mismatch');
        }
        if (identity.epoch > epoch) return;
      }
    }
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

function accountIdentity(bytes: Uint8Array): { objectId: string; epoch: number } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const objectId = 'objectId' in value && typeof value.objectId === 'string' ? value.objectId : undefined;
  const epoch = 'epoch' in value && typeof value.epoch === 'number' ? value.epoch : undefined;
  return objectId !== undefined && epoch !== undefined ? { objectId, epoch } : undefined;
}

export async function ensureAccountActiveFence(
  store: SyncObjectStore,
  objectId: string,
  epoch: number,
  signal: AbortSignal,
): Promise<void> {
  // A restored entity carries no credential yet, so the fence is a tombstone at the new epoch:
  // it must stay a record `decodeAccount()` recognizes, or OAuth readers classify the account as
  // an unknown format and refuse to publish. Present and epoch-bearing is what stops a stale
  // purge from scrubbing the restored account.
  const marker: DeletedAccount = { protocol: 1, phase: 'deleted', objectId, epoch };
  const bytes = encode(marker);
  assertSize(store, bytes);
  const key = accountKey(objectId);
  for (;;) {
    signal.throwIfAborted();
    const beforeHead = await readHeadOrThrow(store, objectId, signal);
    assertActiveFenceHead(beforeHead.head, epoch);
    const current = await store.session.read(key, signal);
    if (current.kind === 'present') {
      const identity = accountIdentity(current.value);
      if (identity?.objectId === objectId && identity.epoch === epoch) return;
      if (identity?.objectId === objectId && identity.epoch > epoch) return;
    }
    const checkedHead = await readHeadOrThrow(store, objectId, signal);
    assertActiveFenceHead(checkedHead.head, epoch);
    if (checkedHead.version !== beforeHead.version) continue;
    try {
      const result = await store.session.compareAndSwap(
        key,
        current.kind === 'absent' ? null : current.version,
        bytes,
        signal,
      );
      if (result.kind === 'written') {
        const afterHead = await readHeadOrThrow(store, objectId, signal);
        assertActiveFenceHead(afterHead.head, epoch);
        return;
      }
    } catch (error) {
      if (error instanceof SyncBackendError && error.code === 'outcome-unknown') {
        const afterHead = await readHeadOrThrow(store, objectId, signal);
        assertActiveFenceHead(afterHead.head, epoch);
        continue;
      }
      throw error;
    }
  }
}

function assertActiveFenceHead(head: EntityHead, epoch: number): void {
  if (head.epoch !== epoch) throw new SyncProtocolError('epoch-mismatch', 'epoch-mismatch');
  if (head.state !== 'active') throw new SyncProtocolError('deleted', 'deleted');
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
  expectedVersion?: string | null,
): Promise<void> {
  let firstExpected = expectedVersion;
  for (;;) {
    signal.throwIfAborted();
    const current = await readHeadOrThrow(store, objectId, signal);
    if (firstExpected !== undefined && current.version !== firstExpected)
      throw new SyncProtocolError('upgrade-required', 'head version changed');
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
        firstExpected ?? undefined,
      );
      firstExpected = undefined;
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

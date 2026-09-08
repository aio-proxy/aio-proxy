import { SyncProtocolError } from '../protocol';
import { decodeRevision, revisionKey } from '../protocol';
import { type SyncObjectStore } from '../publication';
import {
  HISTORY_RETENTION_MS,
  eraseRevision,
  finalizeRevisionReceiptIfPresent,
  readHeadOrThrow,
  revisionMarker,
  updateHead,
} from './cleanup';

async function cancelReservations(store: SyncObjectStore, objectId: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    const current = await readHeadOrThrow(store, objectId, signal);
    if (current.head.state === 'purged') return;
    if (current.head.reserved.length > 0) {
      await updateHead(
        store,
        objectId,
        (head) => ({
          ...head,
          reserved: [],
          cancelling: [...new Set([...head.cancelling, ...head.reserved])],
        }),
        signal,
      );
      continue;
    }
    if (current.head.cancelling.length === 0) return;
    for (const operationId of current.head.cancelling) {
      const latest = await readHeadOrThrow(store, objectId, signal);
      const record = await finalizeRevisionReceiptIfPresent(store, latest.head, operationId, signal);
      const sequence = latest.head.receipts[operationId] ?? record?.publishedSequence ?? undefined;
      await eraseRevision(
        store,
        revisionKey(objectId, operationId),
        revisionMarker(objectId, operationId, latest.head.epoch, sequence, 'abandoned'),
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

async function confirmReceipts(store: SyncObjectStore, objectId: string, signal: AbortSignal): Promise<void> {
  const head = await readHeadOrThrow(store, objectId, signal);
  for (const operationId of [
    ...new Set([...head.head.history, ...(head.head.current === null ? [] : [head.head.current])]),
  ]) {
    if (head.head.receipts[operationId] === undefined) continue;
    const value = await store.session.read(revisionKey(objectId, operationId), signal);
    if (value.kind === 'absent') throw new SyncProtocolError('invalid-data', 'publication receipt has no revision');
    const record = decodeRevision(value.value);
    if (record.state === 'payload') await finalizeRevisionReceiptIfPresent(store, head.head, operationId, signal);
  }
}

export async function collectHistory(
  store: SyncObjectStore,
  objectId: string,
  serverNow: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isFinite(serverNow)) throw new SyncProtocolError('invalid-data', 'invalid server time');
  const initial = await store.readHead(objectId, signal);
  if (initial === null || initial.head.state === 'purged') return;
  await confirmReceipts(store, objectId, signal);
  await cancelReservations(store, objectId, signal);
  const head = await readHeadOrThrow(store, objectId, signal);
  const cutoff = serverNow - HISTORY_RETENTION_MS;
  const pending = new Set([...head.head.reserved, ...head.head.cancelling]);
  const current = head.head.current;
  for (const operationId of head.head.history) {
    if (operationId === current || pending.has(operationId)) continue;
    const value = await store.session.read(revisionKey(objectId, operationId), signal);
    if (value.kind === 'absent') throw new SyncProtocolError('invalid-data', 'history revision is missing');
    const record = decodeRevision(value.value);
    const sequence = head.head.receipts[operationId] ?? record.publishedSequence ?? undefined;
    if (record.state === 'erased') {
      await unlinkExpired(store, objectId, operationId, signal);
      continue;
    }
    if (head.head.receipts[operationId] === undefined || record.publishedSequence === null) continue;
    if (record.writtenAt === null || record.writtenAt >= cutoff) continue;
    await eraseRevision(
      store,
      revisionKey(objectId, operationId),
      revisionMarker(objectId, operationId, record.epoch, sequence, 'expired'),
      signal,
    );
    await unlinkExpired(store, objectId, operationId, signal);
  }
}

async function unlinkExpired(
  store: SyncObjectStore,
  objectId: string,
  operationId: string,
  signal: AbortSignal,
): Promise<void> {
  await updateHead(
    store,
    objectId,
    (head) => {
      if (!head.history.includes(operationId) || head.current === operationId) return head;
      return {
        ...head,
        history: head.history.filter((id) => id !== operationId),
        receipts: Object.fromEntries(Object.entries(head.receipts).filter(([id]) => id !== operationId)),
      };
    },
    signal,
  );
}

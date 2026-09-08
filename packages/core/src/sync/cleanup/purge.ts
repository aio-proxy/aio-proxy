import { SyncProtocolError, type EntityHead } from '../protocol';
import { revisionKey } from '../protocol';
import { beginPurge } from '../protocol/transitions';
import { type SyncObjectStore } from '../publication';
import {
  ensureAccountTombstone,
  eraseRevision,
  finalizeRevisionReceiptIfPresent,
  frozenRevisionIds,
  readHeadOrThrow,
  revisionMarker,
  updateHead,
} from './cleanup';

async function eraseFrozenRevisions(store: SyncObjectStore, head: EntityHead, signal: AbortSignal): Promise<void> {
  for (const operationId of frozenRevisionIds(head)) {
    const record = await finalizeRevisionReceiptIfPresent(store, head, operationId, signal);
    const sequence = head.receipts[operationId] ?? record?.publishedSequence ?? undefined;
    await eraseRevision(
      store,
      revisionKey(head.objectId, operationId),
      revisionMarker(head.objectId, operationId, head.epoch, sequence, 'purged'),
      signal,
    );
  }
}

async function verifyErasedRevisions(store: SyncObjectStore, head: EntityHead, signal: AbortSignal): Promise<void> {
  for (const operationId of frozenRevisionIds(head)) {
    const value = await store.session.read(revisionKey(head.objectId, operationId), signal);
    if (value.kind === 'absent') throw new SyncProtocolError('invalid-data', 'purged revision marker is missing');
    const record = await finalizeRevisionReceiptIfPresent(store, head, operationId, signal);
    if (record !== null && record.state === 'payload') {
      throw new SyncProtocolError('invalid-data', 'purge revision is still a payload');
    }
  }
}

export async function purgeEntity(store: SyncObjectStore, objectId: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const initial = await readHeadOrThrow(store, objectId, signal);
    if (initial.head.state === 'purged') {
      await ensureAccountTombstone(store, objectId, initial.head.epoch, signal);
      await verifyErasedRevisions(store, initial.head, signal);
      return;
    }
    if (initial.head.state !== 'purging') {
      await updateHead(
        store,
        objectId,
        (head) => ({
          ...beginPurge(head),
          cancelling: [...new Set([...head.cancelling, ...head.reserved])],
        }),
        signal,
      );
      continue;
    }

    const frozen = await readHeadOrThrow(store, objectId, signal);
    await eraseFrozenRevisions(store, frozen.head, signal);
    await ensureAccountTombstone(store, objectId, frozen.head.epoch, signal);
    await verifyErasedRevisions(store, frozen.head, signal);
    const latest = await readHeadOrThrow(store, objectId, signal);
    if (latest.head.state === 'purged') return;
    if (latest.head.state !== 'purging') continue;
    await updateHead(
      store,
      objectId,
      (head) => (head.state === 'purging' ? { ...head, state: 'purged', cleanupComplete: true } : head),
      signal,
    );
  }
}

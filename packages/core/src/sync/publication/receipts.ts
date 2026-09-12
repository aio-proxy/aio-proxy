import { decodeRevision, encode, revisionKey, SyncProtocolError, type EntityHead } from '../protocol';
import { assertSize, type SyncObjectStore } from './publication';

export async function finalizeReceipt(
  store: SyncObjectStore,
  head: EntityHead,
  operationId: string,
  signal: AbortSignal,
): Promise<void> {
  const sequence = head.receipts[operationId];
  if (sequence === undefined) throw new SyncProtocolError('invalid-data', 'missing publication receipt');
  const key = revisionKey(head.objectId, operationId);
  for (;;) {
    signal.throwIfAborted();
    const value = await store.session.read(key, signal);
    if (value.kind === 'absent') throw new SyncProtocolError('invalid-data', 'publication receipt has no revision');
    const record = decodeRevision(value.value);
    if (record.objectId !== head.objectId || record.operationId !== operationId) {
      throw new SyncProtocolError('invalid-data', 'revision identity mismatch');
    }
    if (record.state === 'erased') {
      if (record.publishedSequence !== sequence)
        throw new SyncProtocolError('invalid-data', 'erased receipt sequence mismatch');
      return;
    }
    if (record.publishedSequence !== null && record.publishedSequence !== sequence) {
      throw new SyncProtocolError('invalid-data', 'publication receipt sequence mismatch');
    }
    if (record.publishedSequence === sequence && record.writtenAt !== null) return;
    const next = {
      ...record,
      publishedSequence: sequence,
      writtenAt: record.writtenAt ?? value.modifiedAt,
    } as const;
    const bytes = encode(next);
    assertSize(store, bytes);
    const result = await store.session.compareAndSwap(key, value.version, bytes, signal);
    if (result.kind === 'written') return;
  }
}

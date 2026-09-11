import { SyncProtocolError, type EntityBody } from '../protocol';
import { publishEntity, type PublishedRevision, type SyncObjectStore } from '../publication';
import type { OutboxOperation } from '../repository';
import { ensureAccountActiveFence, readHeadOrThrow, updateHead } from './cleanup';

export async function restoreEntity(
  store: SyncObjectStore,
  objectId: string,
  body: EntityBody,
  operationId: string,
  signal: AbortSignal,
  expectedVersion?: string | null,
): Promise<PublishedRevision> {
  for (;;) {
    const current = await readHeadOrThrow(store, objectId, signal);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw new SyncProtocolError('upgrade-required', 'head version changed');
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
      return publishEntity(store, operation, signal, current.version);
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
      expectedVersion ?? undefined,
    );
    await ensureAccountActiveFence(store, objectId, restored.head.epoch, signal);
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

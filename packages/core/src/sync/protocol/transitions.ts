import type { EntityBody, EntityHead } from './protocol';
import { SyncProtocolError } from './protocol';

function assertActiveAndEpoch(head: EntityHead, epoch: number): void {
  if (head.state !== 'active') throw new SyncProtocolError('deleted', 'deleted');
  if (head.epoch !== epoch) throw new SyncProtocolError('epoch-mismatch', 'epoch-mismatch');
}

export function newHead(objectId: string, body: EntityBody): EntityHead {
  return {
    protocol: 1,
    objectId,
    kind: body.kind,
    logicalKey: body.logicalKey,
    epoch: 0,
    sequence: 0,
    state: 'active',
    current: null,
    history: [],
    reserved: [],
    cancelling: [],
    receipts: {},
    cleanupComplete: true,
  };
}

export function reserve(head: EntityHead, operationId: string, epoch: number): EntityHead {
  assertActiveAndEpoch(head, epoch);
  if (head.cancelling.includes(operationId))
    throw new SyncProtocolError('invalid-data', 'operation is being cancelled');
  if (head.current === operationId || head.history.includes(operationId) || head.reserved.includes(operationId))
    return head;
  return { ...head, reserved: [...head.reserved, operationId] };
}

export function publish(head: EntityHead, operationId: string, epoch: number): EntityHead {
  assertActiveAndEpoch(head, epoch);
  if (head.current === operationId || head.history.includes(operationId)) return head;
  if (!head.reserved.includes(operationId)) throw new SyncProtocolError('invalid-data', 'operation was not reserved');
  const sequence = head.sequence + 1;
  return {
    ...head,
    sequence,
    current: operationId,
    receipts: { ...head.receipts, [operationId]: sequence },
    history: head.current === null ? head.history : [...head.history, head.current],
    reserved: head.reserved.filter((id) => id !== operationId),
  };
}

export function beginPurge(head: EntityHead): EntityHead {
  if (head.state === 'purging' || head.state === 'purged') return head;
  if (head.state === 'deleted') throw new SyncProtocolError('deleted', 'deleted');
  return { ...head, state: 'purging', cleanupComplete: false };
}

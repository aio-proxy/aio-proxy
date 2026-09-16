import { omit } from 'es-toolkit/object';
import { isEqual } from 'es-toolkit/predicate';

import { SyncProtocolError } from '../protocol';
import { decodeRevision, receiptSequence, revisionKey, type EntityHead } from '../protocol';
import { type SyncObjectStore } from '../publication';
import {
  HISTORY_RETENTION_MS,
  MAX_HISTORY_REVISIONS,
  eraseRevision,
  finalizeRevisionReceiptIfPresent,
  readHeadOrThrow,
  revisionMarker,
  updateHead,
} from './cleanup';

// Routine maintenance runs on whichever device happens to be awake, so a reservation it finds may
// belong to another device that is mid-publication. Abandoning that one makes `publishEntity()`
// reject the uploader's persisted operation ID forever and blocks its outbox, so only reclaim a
// reservation the cloud state itself proves dead. Deletion and purge still cancel everything: the
// object is going away either way.
async function reservationVerdict(
  store: SyncObjectStore,
  objectId: string,
  operationId: string,
  cutoff: number,
  signal: AbortSignal,
): Promise<'live' | 'stale' | 'unstaged'> {
  const value = await store.session.read(revisionKey(objectId, operationId), signal);
  // No revision yet is both a publisher between reserving and writing its payload — a window of
  // milliseconds that proves nothing — and what a publisher interrupted in that window leaves
  // behind forever. Indistinguishable from here, so age it from when maintenance first saw it.
  if (value.kind === 'absent') return 'unstaged';
  const record = decodeRevision(value.value);
  if (record.state !== 'payload') return 'stale';
  return (record.writtenAt ?? value.modifiedAt) < cutoff ? 'stale' : 'live';
}

/** An operation ID is an unrestricted wire string, so an inherited key must not read as a stamp. */
function stampedAt(head: EntityHead, operationId: string): number | undefined {
  const stamps = head.reservedAt;
  return stamps !== undefined && Object.hasOwn(stamps, operationId) ? stamps[operationId] : undefined;
}

// Stamps are rebuilt from the reservations still unstaged, so one write both ages the newcomers and
// drops entries for operations that have since published, cancelled, or been reclaimed.
function stampUnstaged(head: EntityHead, unstaged: string[], serverNow: number): EntityHead {
  const stamps = Object.fromEntries(
    unstaged.filter((id) => head.reserved.includes(id)).map((id) => [id, stampedAt(head, id) ?? serverNow]),
  );
  const next = Object.keys(stamps).length === 0 ? undefined : stamps;
  if (isEqual(head.reservedAt, next)) return head;
  return next === undefined ? omit(head, ['reservedAt']) : { ...head, reservedAt: next };
}

async function cancelReservations(
  store: SyncObjectStore,
  objectId: string,
  serverNow: number,
  cutoff: number,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    const current = await readHeadOrThrow(store, objectId, signal);
    if (current.head.state === 'purged') return;
    const stale: string[] = [];
    const aged: string[] = [];
    const unstaged: string[] = [];
    for (const operationId of current.head.reserved) {
      const verdict = await reservationVerdict(store, objectId, operationId, cutoff, signal);
      if (verdict === 'live') continue;
      if (verdict === 'stale') {
        stale.push(operationId);
        continue;
      }
      const since = stampedAt(current.head, operationId);
      if (since !== undefined && since < cutoff) aged.push(operationId);
      else unstaged.push(operationId);
    }
    // An aged reservation is reclaimed on the absence of its payload alone, and that read is already
    // stale: the verdicts above are one round trip each, and a publisher resuming in any of them
    // stages its payload while its ID is still reserved. Cancelling it then erases that payload and
    // strands its outbox entry for good, because `reserve()` and `publish()` both refuse an ID the
    // head lists as cancelling. Rereading here is the last look before the write.
    // ponytail: narrows the window to a single round trip; closing it needs a transaction across the
    // head and revision keys that the backends do not offer.
    for (const operationId of aged) {
      if ((await reservationVerdict(store, objectId, operationId, cutoff, signal)) === 'live') continue;
      stale.push(operationId);
    }
    if (stale.length > 0) {
      await updateHead(
        store,
        objectId,
        (head) => {
          // The publisher may have resumed and published between the staleness read and this write.
          // Cancelling an operation the head now points at erases the current revision's payload, so
          // only reclaim IDs the head still lists as reserved.
          const reclaimed = stale.filter((id) => head.reserved.includes(id));
          if (reclaimed.length === 0) return head;
          return {
            ...head,
            reserved: head.reserved.filter((id) => !reclaimed.includes(id)),
            cancelling: [...new Set([...head.cancelling, ...reclaimed])],
          };
        },
        signal,
      );
      continue;
    }
    await updateHead(store, objectId, (head) => stampUnstaged(head, unstaged, serverNow), signal);
    if (current.head.cancelling.length === 0) return;
    for (const operationId of current.head.cancelling) {
      const latest = await readHeadOrThrow(store, objectId, signal);
      const record = await finalizeRevisionReceiptIfPresent(store, latest.head, operationId, signal);
      const sequence = receiptSequence(latest.head, operationId) ?? record?.publishedSequence ?? undefined;
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
    if (receiptSequence(head.head, operationId) === undefined) continue;
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
  const cutoff = serverNow - HISTORY_RETENTION_MS;
  await cancelReservations(store, objectId, serverNow, cutoff, signal);
  const head = await readHeadOrThrow(store, objectId, signal);
  const pending = new Set([...head.head.reserved, ...head.head.cancelling]);
  const current = head.head.current;
  // `history` is append-ordered, so the entries the cap sheds are the ones at the front — the same
  // ones the age cutoff would reach first.
  const overflow = new Set(head.head.history.slice(0, Math.max(0, head.head.history.length - MAX_HISTORY_REVISIONS)));
  for (const operationId of head.head.history) {
    if (operationId === current || pending.has(operationId)) continue;
    const value = await store.session.read(revisionKey(objectId, operationId), signal);
    if (value.kind === 'absent') throw new SyncProtocolError('invalid-data', 'history revision is missing');
    const record = decodeRevision(value.value);
    const sequence = receiptSequence(head.head, operationId) ?? record.publishedSequence ?? undefined;
    if (record.state === 'erased') {
      await unlinkExpired(store, objectId, operationId, signal);
      continue;
    }
    if (receiptSequence(head.head, operationId) === undefined || record.publishedSequence === null) continue;
    // A revision with no recorded write time never expires on age alone, so the cap is also what
    // stops one from pinning a slot in the head for good.
    if (!overflow.has(operationId) && (record.writtenAt === null || record.writtenAt >= cutoff)) continue;
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

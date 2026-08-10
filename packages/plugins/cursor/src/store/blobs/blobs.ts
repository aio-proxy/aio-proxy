import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

// Content-addressed blob helpers. The hex key matches Cursor's
// `Buffer.from(blobId).toString('hex')`, so KV server writes (Task 15) and the
// history builder (Task 12) address the same bytes. Identical data collapses to
// one entry, and the whole store is bounded by the parent session lru-cache.
export function createBlobId(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function blobKey(blobId: Uint8Array): string {
  return Buffer.from(blobId).toString('hex');
}

export function storeCursorBlob(store: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
  const blobId = createBlobId(data);
  store.set(blobKey(blobId), data);
  return blobId;
}

export function readCursorBlob(store: ReadonlyMap<string, Uint8Array>, blobId: Uint8Array): Uint8Array | undefined {
  return store.get(blobKey(blobId));
}

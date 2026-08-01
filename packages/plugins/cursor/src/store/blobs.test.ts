import { expect, test } from 'bun:test';

import { blobKey, createBlobId, readCursorBlob, storeCursorBlob } from './blobs';

test('stores content-addressed blobs and round-trips them', () => {
  const store = new Map<string, Uint8Array>();
  const data = new TextEncoder().encode('hello');
  const id = storeCursorBlob(store, data);
  expect(storeCursorBlob(store, new TextEncoder().encode('hello'))).toEqual(id);
  expect(store.size).toBe(1);
  expect([...(readCursorBlob(store, id) ?? [])]).toEqual([...data]);
});

test('a missing blob reads undefined and keys are hex', () => {
  const store = new Map<string, Uint8Array>();
  const id = createBlobId(new Uint8Array([1, 2, 3]));
  expect(readCursorBlob(store, id)).toBeUndefined();
  expect(blobKey(id)).toMatch(/^[0-9a-f]{64}$/);
});

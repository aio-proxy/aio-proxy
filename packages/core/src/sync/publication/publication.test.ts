import { expect, test } from 'bun:test';

import { SyncBackendError } from '@aio-proxy/plugin-sdk';

import { decodeHead, decodeRevision, encode, entityKey, newHead, reserve, revisionKey } from '../protocol';
import { createMemorySyncBackend } from '../test-support';
import { createSyncObjectStore, publishEntity } from './publication';

function makeOperation(
  overrides: Partial<{
    operationId: string;
    objectId: string;
    epoch: number;
    body: { kind: 'provider'; logicalKey: string; value: Record<string, string>; dependencies: [] };
  }> = {},
) {
  return {
    operationId: overrides.operationId ?? crypto.randomUUID(),
    objectId: overrides.objectId ?? crypto.randomUUID(),
    epoch: overrides.epoch ?? 0,
    kind: 'put' as const,
    commitId: 'commit-1',
    body: overrides.body ?? { kind: 'provider' as const, logicalKey: 'work', value: { apiKey: 'k' }, dependencies: [] },
  };
}

test('unknown CAS result retries the same operation without another revision', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const signal = new AbortController().signal;
  const operation = makeOperation();
  backend.failNext('compareAndSwap', 'after');
  await publishEntity(store, operation, signal).catch(() => undefined);
  const first = await publishEntity(store, operation, signal);
  const retried = await publishEntity(store, operation, signal);
  expect(retried).toEqual(first);
  expect((await store.readHead(operation.objectId, signal))?.head.sequence).toBe(1);
});

test('concurrent clients publish complete entity bodies in CAS order', async () => {
  const backend = createMemorySyncBackend();
  const a = createSyncObjectStore(backend.connect());
  const b = createSyncObjectStore(backend.connect());
  const first = makeOperation();
  const second = makeOperation({
    objectId: first.objectId,
    body: { kind: 'provider', logicalKey: 'work', value: { apiKey: 'new' }, dependencies: [] },
  });
  const signal = new AbortController().signal;
  const [left, right] = await Promise.all([publishEntity(a, first, signal), publishEntity(b, second, signal)]);
  const head = (await a.readHead(first.objectId, signal))!;
  expect(new Set([left.sequence, right.sequence])).toEqual(new Set([1, 2]));
  expect(head.head.current).toBe(
    right.sequence === head.head.receipts[second.operationId] ? second.operationId : first.operationId,
  );
  expect(head.head.history).toHaveLength(1);
  const current = backend.readAll().get(`s/v1/default/revision/${first.objectId}/${head.head.current}`);
  expect(current?.kind).toBe('present');
  expect(decodeRevision(current!.value)).toMatchObject({ state: 'payload', publishedSequence: head.head.sequence });
});

test('a duplicate operation returns the retained erased publication receipt', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const item = makeOperation();
  const signal = new AbortController().signal;
  const published = await publishEntity(store, item, signal);
  const headValue = backend.readAll().get(entityKey(item.objectId));
  expect(headValue?.kind).toBe('present');
  const head = decodeHead(headValue!.value);
  const erased = encode({
    protocol: 1,
    state: 'erased',
    objectId: item.objectId,
    epoch: item.epoch,
    operationId: item.operationId,
    publishedSequence: published.sequence,
    reason: 'expired',
  });
  const revisionValue = backend.readAll().get(revisionKey(item.objectId, item.operationId));
  expect(revisionValue?.kind).toBe('present');
  const result = await store.session.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    revisionValue!.version,
    erased,
    signal,
  );
  expect(result.kind).toBe('written');
  const withoutReceipt = { ...head, receipts: {} };
  const headResult = await store.session.compareAndSwap(
    entityKey(item.objectId),
    headValue!.version,
    encode(withoutReceipt),
    signal,
  );
  expect(headResult.kind).toBe('written');
  expect(await publishEntity(store, item, signal)).toEqual(published);
});

test('a tombstone rejects a late duplicate and never creates a replacement head', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const item = makeOperation();
  const signal = new AbortController().signal;
  const head = { ...newHead(item.objectId, item.body), state: 'deleted' as const, cleanupComplete: true };
  expect((await session.compareAndSwap(entityKey(item.objectId), null, encode(head), signal)).kind).toBe('written');
  await expect(publishEntity(createSyncObjectStore(session), item, signal)).rejects.toThrow('deleted');
  expect(decodeHead(backend.readAll().get(entityKey(item.objectId))!.value).state).toBe('deleted');
});

test('payload and publication metadata preserve the original storage timestamp', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const item = makeOperation();
  const signal = new AbortController().signal;
  const result = await publishEntity(store, item, signal);
  const revision = backend.readAll().get(revisionKey(item.objectId, item.operationId));
  expect(revision?.kind).toBe('present');
  const decoded = decodeRevision(revision!.value);
  expect(decoded).toMatchObject({ publishedSequence: result.sequence, writtenAt: revision!.modifiedAt });
});

test('quota and offline failures are returned without a retry loop', async () => {
  const backend = createMemorySyncBackend();
  const base = backend.connect();
  const session = { ...base, maxValueBytes: 1 };
  const item = makeOperation({
    body: { kind: 'provider', logicalKey: 'work', value: { apiKey: 'large' }, dependencies: [] },
  });
  const signal = new AbortController().signal;
  await expect(publishEntity(createSyncObjectStore(session), item, signal)).rejects.toBeInstanceOf(SyncBackendError);
  expect((await session.read(entityKey(item.objectId), signal)).kind).toBe('absent');

  const offline = createMemorySyncBackend();
  const offlineStore = createSyncObjectStore(offline.connect());
  offline.failNext('read', 'before');
  await expect(publishEntity(offlineStore, makeOperation(), signal)).rejects.toMatchObject({ code: 'offline' });
});

test('dependency references are published before their payloads exist', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const item = makeOperation({
    body: {
      kind: 'provider',
      logicalKey: 'work',
      value: { apiKey: 'k' },
      dependencies: [{ objectId: 'missing-plugin', packageName: '@example/plugin', version: '1.0.0' }],
    },
  });
  await expect(publishEntity(store, item, new AbortController().signal)).resolves.toMatchObject({
    operationId: item.operationId,
  });
});

test('cleanup fencing prevents a cancelled reservation from publishing', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const store = createSyncObjectStore(session);
  const item = makeOperation();
  const signal = new AbortController().signal;
  const initial = newHead(item.objectId, item.body);
  const reserved = reserve(initial, item.operationId, item.epoch);
  const cancelling = { ...reserved, cancelling: [item.operationId] };
  expect((await session.compareAndSwap(entityKey(item.objectId), null, encode(cancelling), signal)).kind).toBe(
    'written',
  );
  await expect(publishEntity(store, item, signal)).rejects.toThrow('cancel');
  expect(backend.readAll().has(revisionKey(item.objectId, item.operationId))).toBe(false);
});

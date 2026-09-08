import { expect, test } from 'bun:test';

import { SyncBackendError, type SyncSession } from '@aio-proxy/plugin-sdk';

import { decodeHead, decodeRevision, encode, entityKey, newHead, publish, reserve, revisionKey } from '../protocol';
import { createMemorySyncBackend } from '../test-support';
import { createSyncObjectStore, finalizeReceipt, publishEntity } from './publication';

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

function failAfterCompareAndSwap(session: SyncSession, target: number): SyncSession {
  let calls = 0;
  return {
    ...session,
    async compareAndSwap(key, expected, value, signal) {
      calls++;
      const result = await session.compareAndSwap(key, expected, value, signal);
      if (calls === target) throw new SyncBackendError('outcome-unknown', 'Sync write outcome is unknown');
      return result;
    },
  };
}

function revisionKeys(backend: ReturnType<typeof createMemorySyncBackend>, objectId: string): string[] {
  return [...backend.readAll().keys()].filter((key) => key.startsWith(`s/v1/default/revision/${objectId}/`));
}

test('unknown CAS result retries the same operation without another revision', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const signal = new AbortController().signal;
  const operation = makeOperation();
  backend.failNext('compareAndSwap', 'after');
  await expect(publishEntity(store, operation, signal)).rejects.toMatchObject({ code: 'outcome-unknown' });
  const first = await publishEntity(store, operation, signal);
  const retried = await publishEntity(store, operation, signal);
  expect(retried).toEqual(first);
  expect((await store.readHead(operation.objectId, signal))?.head.sequence).toBe(1);
});

test('outcome-unknown at every publication CAS position is recoverable with one operation', async () => {
  for (const position of [1, 2, 3, 4, 5]) {
    const backend = createMemorySyncBackend();
    const operation = makeOperation();
    const session = failAfterCompareAndSwap(backend.connect(), position);
    const store = createSyncObjectStore(session);
    const signal = new AbortController().signal;
    await expect(publishEntity(store, operation, signal)).rejects.toMatchObject({ code: 'outcome-unknown' });
    const result = await publishEntity(store, operation, signal);
    expect(result).toEqual({ operationId: operation.operationId, sequence: 1 });
    expect(await publishEntity(store, operation, signal)).toEqual(result);
    expect(revisionKeys(backend, operation.objectId)).toEqual([revisionKey(operation.objectId, operation.operationId)]);
    expect((await store.readHead(operation.objectId, signal))?.head.sequence).toBe(1);
  }
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

test('independent entities merge without sharing a head sequence', async () => {
  const backend = createMemorySyncBackend();
  const left = createSyncObjectStore(backend.connect());
  const right = createSyncObjectStore(backend.connect());
  const first = makeOperation();
  const second = makeOperation({
    body: { kind: 'provider', logicalKey: 'personal', value: { apiKey: 'p' }, dependencies: [] },
  });
  const signal = new AbortController().signal;
  const [leftResult, rightResult] = await Promise.all([
    publishEntity(left, first, signal),
    publishEntity(right, second, signal),
  ]);
  expect(leftResult.sequence).toBe(1);
  expect(rightResult.sequence).toBe(1);
  expect((await left.readHead(first.objectId, signal))?.head.current).toBe(first.operationId);
  expect((await right.readHead(second.objectId, signal))?.head.current).toBe(second.operationId);
});

test('a paused older writer publishes after a newer submission and wins by successful CAS order', async () => {
  const backend = createMemorySyncBackend();
  const seedSession = backend.connect();
  const old = makeOperation();
  const newer = makeOperation({
    objectId: old.objectId,
    body: { kind: 'provider', logicalKey: 'work', value: { apiKey: 'newer' }, dependencies: [] },
  });
  const signal = new AbortController().signal;
  expect(
    (await seedSession.compareAndSwap(entityKey(old.objectId), null, encode(newHead(old.objectId, old.body)), signal))
      .kind,
  ).toBe('written');
  const gate = backend.gateNext('compareAndSwap');
  const oldPromise = publishEntity(createSyncObjectStore(backend.connect()), old, signal);
  await gate.entered;
  const newerResult = await publishEntity(createSyncObjectStore(backend.connect()), newer, signal);
  gate.release();
  const oldResult = await oldPromise;
  expect(newerResult.sequence).toBe(1);
  expect(oldResult.sequence).toBe(2);
  const head = (await createSyncObjectStore(seedSession).readHead(old.objectId, signal))!;
  expect(head.head).toMatchObject({ current: old.operationId, history: [newer.operationId], sequence: 2 });
});

test('out-of-order acknowledgement of an older operation does not overwrite the newer current revision', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const first = makeOperation();
  const second = makeOperation({
    objectId: first.objectId,
    body: { kind: 'provider', logicalKey: 'work', value: { apiKey: 'second' }, dependencies: [] },
  });
  const signal = new AbortController().signal;
  const firstResult = await publishEntity(store, first, signal);
  const secondResult = await publishEntity(store, second, signal);
  const lateFirstAck = await publishEntity(store, first, signal);
  expect(firstResult.sequence).toBe(1);
  expect(secondResult.sequence).toBe(2);
  expect(lateFirstAck).toEqual(firstResult);
  expect((await store.readHead(first.objectId, signal))?.head.current).toBe(second.operationId);
  expect(revisionKeys(backend, first.objectId)).toHaveLength(2);
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

test('publication rejects a wrong logical identity without changing the existing head', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const original = makeOperation();
  const conflicting = makeOperation({ objectId: original.objectId, body: { ...original.body, logicalKey: 'other' } });
  const signal = new AbortController().signal;
  expect(
    (
      await session.compareAndSwap(
        entityKey(original.objectId),
        null,
        encode(newHead(original.objectId, original.body)),
        signal,
      )
    ).kind,
  ).toBe('written');
  await expect(publishEntity(createSyncObjectStore(session), conflicting, signal)).rejects.toThrow('logical identity');
  expect(decodeHead(backend.readAll().get(entityKey(original.objectId))!.value).logicalKey).toBe('work');
});

test('publication rejects a stale epoch before creating a revision', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const current = makeOperation();
  const stale = makeOperation({ objectId: current.objectId, epoch: 1 });
  const signal = new AbortController().signal;
  expect(
    (
      await session.compareAndSwap(
        entityKey(current.objectId),
        null,
        encode(newHead(current.objectId, current.body)),
        signal,
      )
    ).kind,
  ).toBe('written');
  await expect(publishEntity(createSyncObjectStore(session), stale, signal)).rejects.toThrow('epoch-mismatch');
  expect(revisionKeys(backend, stale.objectId)).toHaveLength(0);
});

test('purging and purged heads fence late publication attempts', async () => {
  for (const state of ['purging', 'purged'] as const) {
    const backend = createMemorySyncBackend();
    const session = backend.connect();
    const item = makeOperation();
    const signal = new AbortController().signal;
    const head = { ...newHead(item.objectId, item.body), state, cleanupComplete: state === 'purged' };
    expect((await session.compareAndSwap(entityKey(item.objectId), null, encode(head), signal)).kind).toBe('written');
    await expect(publishEntity(createSyncObjectStore(session), item, signal)).rejects.toThrow('deleted');
    expect(revisionKeys(backend, item.objectId)).toHaveLength(0);
  }
});

test('payload and publication metadata preserve the original storage timestamp', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const store = createSyncObjectStore(session);
  const item = makeOperation();
  const signal = new AbortController().signal;
  const reserved = reserve(newHead(item.objectId, item.body), item.operationId, item.epoch);
  const headWrite = await session.compareAndSwap(entityKey(item.objectId), null, encode(reserved), signal);
  expect(headWrite.kind).toBe('written');
  if (headWrite.kind !== 'written') throw new Error('head seed failed');
  const payload = encode({
    protocol: 1,
    state: 'payload',
    objectId: item.objectId,
    epoch: item.epoch,
    operationId: item.operationId,
    body: item.body,
    publishedSequence: null,
    writtenAt: null,
  });
  const payloadWrite = await session.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    null,
    payload,
    signal,
  );
  expect(payloadWrite.kind).toBe('written');
  if (payloadWrite.kind !== 'written') throw new Error('payload seed failed');
  const published = publish(reserved, item.operationId, item.epoch);
  const publishedHead = await session.compareAndSwap(
    entityKey(item.objectId),
    headWrite.version,
    encode(published),
    signal,
  );
  expect(publishedHead.kind).toBe('written');
  backend.advance(1000);
  await finalizeReceipt(store, published, item.operationId, signal);
  const revision = backend.readAll().get(revisionKey(item.objectId, item.operationId));
  expect(revision?.kind).toBe('present');
  const decoded = decodeRevision(revision!.value);
  expect(decoded).toMatchObject({ publishedSequence: 1, writtenAt: payloadWrite.modifiedAt });
  expect(revision!.modifiedAt).toBeGreaterThan(payloadWrite.modifiedAt);
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

  const oversizedBackend = createMemorySyncBackend();
  const oversizedBase = oversizedBackend.connect();
  const oversizedSession = { ...oversizedBase, maxValueBytes: 512 };
  const marker = 'oversized-config-marker';
  const oversized = makeOperation({
    body: { kind: 'provider', logicalKey: 'work', value: { apiKey: `${marker}${'x'.repeat(4000)}` }, dependencies: [] },
  });
  await expect(publishEntity(createSyncObjectStore(oversizedSession), oversized, signal)).rejects.toMatchObject({
    code: 'quota',
  });
  const stored = oversizedBackend.readAll();
  expect(revisionKeys(oversizedBackend, oversized.objectId)).toHaveLength(0);
  expect([...stored.keys()].every((key) => !key.startsWith('s/v1/default/account/'))).toBe(true);
  expect([...stored.values()].every((value) => !new TextDecoder().decode(value.value).includes(marker))).toBe(true);
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

test('a duplicate after cleanup erases the reservation cannot reserve or publish again', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const store = createSyncObjectStore(session);
  const item = makeOperation();
  const signal = new AbortController().signal;
  const reserved = reserve(newHead(item.objectId, item.body), item.operationId, item.epoch);
  const headWrite = await session.compareAndSwap(entityKey(item.objectId), null, encode(reserved), signal);
  expect(headWrite.kind).toBe('written');
  if (headWrite.kind !== 'written') throw new Error('head seed failed');
  const payload = encode({
    protocol: 1,
    state: 'payload',
    objectId: item.objectId,
    epoch: item.epoch,
    operationId: item.operationId,
    body: item.body,
    publishedSequence: null,
    writtenAt: null,
  });
  const revisionWrite = await session.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    null,
    payload,
    signal,
  );
  expect(revisionWrite.kind).toBe('written');
  if (revisionWrite.kind !== 'written') throw new Error('payload seed failed');

  const cancelling = { ...reserved, cancelling: [item.operationId] };
  const cancellationWrite = await session.compareAndSwap(
    entityKey(item.objectId),
    headWrite.version,
    encode(cancelling),
    signal,
  );
  expect(cancellationWrite.kind).toBe('written');
  if (cancellationWrite.kind !== 'written') throw new Error('cancellation failed');
  const erased = encode({
    protocol: 1,
    state: 'erased',
    objectId: item.objectId,
    epoch: item.epoch,
    operationId: item.operationId,
    publishedSequence: null,
    reason: 'abandoned',
  });
  const eraseWrite = await session.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    revisionWrite.version,
    erased,
    signal,
  );
  expect(eraseWrite.kind).toBe('written');
  const complete = { ...cancelling, reserved: [], cancelling: [], cleanupComplete: true };
  const completionWrite = await session.compareAndSwap(
    entityKey(item.objectId),
    cancellationWrite.version,
    encode(complete),
    signal,
  );
  expect(completionWrite.kind).toBe('written');

  await expect(publishEntity(store, item, signal)).rejects.toThrow('abandoned');
  const finalHead = decodeHead(backend.readAll().get(entityKey(item.objectId))!.value);
  expect(finalHead).toMatchObject({ current: null, reserved: [], cancelling: [], receipts: {} });
  expect(decodeRevision(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value)).toMatchObject({
    state: 'erased',
    reason: 'abandoned',
    publishedSequence: null,
  });
});

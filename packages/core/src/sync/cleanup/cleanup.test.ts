import { expect, test } from 'bun:test';

import { accountKey, decodeHead, decodeRevision, encode, entityKey, newHead, reserve, revisionKey } from '../protocol';
import { createSyncObjectStore, publishEntity } from '../publication';
import { createMemorySyncBackend } from '../test-support';
import { collectHistory, deleteEntity, purgeEntity, readServerTime, restoreEntity } from './index';

function operation(objectId: string, operationId = crypto.randomUUID(), value = 'secret') {
  return {
    operationId,
    objectId,
    epoch: 0,
    kind: 'put' as const,
    commitId: 'test',
    body: { kind: 'provider' as const, logicalKey: 'work', value: { apiKey: value }, dependencies: [] },
  };
}

function head(backend: ReturnType<typeof createMemorySyncBackend>, objectId: string) {
  const value = backend.readAll().get(entityKey(objectId));
  if (value?.kind !== 'present') throw new Error('missing head');
  return decodeHead(value.value);
}

test('purge fills an absent reserved key so a paused uploader cannot recreate secrets', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const signal = new AbortController().signal;
  const item = operation(crypto.randomUUID());
  const reserved = reserve(newHead(item.objectId, item.body), item.operationId, 0);
  await session.compareAndSwap(entityKey(item.objectId), null, encode(reserved), signal);

  await purgeEntity(createSyncObjectStore(session), item.objectId, signal);
  const late = await session.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    null,
    encode({ apiKey: 'late-secret' }),
    signal,
  );
  expect(late.kind).toBe('conflict');
  const records = [...backend.readAll().values()]
    .filter((value) => value.kind === 'present')
    .map((value) => new TextDecoder().decode(value.value));
  expect(records.join('\n')).not.toContain('late-secret');
  expect(head(backend, item.objectId).state).toBe('purged');
});

test('purge erases a payload uploaded by a paused writer before publication', async () => {
  const backend = createMemorySyncBackend();
  const seed = createSyncObjectStore(backend.connect());
  const item = operation(crypto.randomUUID());
  const signal = new AbortController().signal;
  await seed.session.compareAndSwap(entityKey(item.objectId), null, encode(newHead(item.objectId, item.body)), signal);
  const afterPayload = backend.gateAfterNext('compareAndSwap');
  const writer = publishEntity(createSyncObjectStore(backend.connect()), item, signal);
  await afterPayload.entered;
  const cleanup = purgeEntity(createSyncObjectStore(backend.connect()), item.objectId, signal);
  afterPayload.release();
  await expect(writer).rejects.toMatchObject({ code: 'deleted' });
  await cleanup;
  const revision = decodeRevision(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value);
  expect(revision).toMatchObject({ state: 'erased', reason: 'purged' });
});

test('ordinary deletion retains current history while scrubbing the account', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const first = operation(crypto.randomUUID(), crypto.randomUUID(), 'first');
  const second = operation(first.objectId, crypto.randomUUID(), 'second');
  await publishEntity(store, first, new AbortController().signal);
  await publishEntity(store, second, new AbortController().signal);
  const signal = new AbortController().signal;
  const account = store.session;
  await account.compareAndSwap(accountKey(first.objectId), null, encode({ credential: 'token' }), signal);

  await deleteEntity(store, first.objectId, 0, signal);
  const deleted = head(backend, first.objectId);
  expect(deleted).toMatchObject({ state: 'deleted', cleanupComplete: true, current: second.operationId });
  expect(deleted.history).toContain(first.operationId);
  const accountValue = backend.readAll().get(accountKey(first.objectId));
  expect(accountValue?.kind).toBe('present');
  expect(new TextDecoder().decode(accountValue!.value)).not.toContain('token');
});

test('history keeps current and expires only old confirmed history', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const first = operation(crypto.randomUUID(), crypto.randomUUID(), 'first');
  const second = operation(first.objectId, crypto.randomUUID(), 'second');
  const signal = new AbortController().signal;
  await publishEntity(store, first, signal);
  backend.advance(31 * 24 * 60 * 60 * 1000);
  await publishEntity(store, second, signal);
  await collectHistory(store, first.objectId, 31 * 24 * 60 * 60 * 1000, signal);
  const current = head(backend, first.objectId);
  expect(current.current).toBe(second.operationId);
  expect(current.history).toEqual([]);
  const old = decodeRevision(backend.readAll().get(revisionKey(first.objectId, first.operationId))!.value);
  expect(old).toMatchObject({ state: 'erased', reason: 'expired', publishedSequence: 1 });
});

test('history keeps revisions younger than 30 days and current revisions at any age', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const first = operation(crypto.randomUUID(), crypto.randomUUID(), 'first');
  const second = operation(first.objectId, crypto.randomUUID(), 'second');
  const signal = new AbortController().signal;
  await publishEntity(store, first, signal);
  backend.advance(29 * 24 * 60 * 60 * 1000);
  await publishEntity(store, second, signal);
  await collectHistory(store, first.objectId, 29 * 24 * 60 * 60 * 1000, signal);
  expect(head(backend, first.objectId).history).toEqual([first.operationId]);
  await collectHistory(store, first.objectId, 30 * 24 * 60 * 60 * 1000, signal);
  expect(head(backend, first.objectId).history).toEqual([first.operationId]);
  await collectHistory(store, first.objectId, 31 * 24 * 60 * 60 * 1000, signal);
  expect(head(backend, first.objectId).history).toEqual([]);

  const current = operation(crypto.randomUUID(), crypto.randomUUID(), 'current');
  await publishEntity(store, current, signal);
  await collectHistory(store, current.objectId, 31 * 24 * 60 * 60 * 1000, signal);
  expect(head(backend, current.objectId).current).toBe(current.operationId);
});

test('an expired operation keeps its permanent publication receipt for retries', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const first = operation(crypto.randomUUID(), crypto.randomUUID(), 'first');
  const second = operation(first.objectId, crypto.randomUUID(), 'second');
  const signal = new AbortController().signal;
  const published = await publishEntity(store, first, signal);
  await publishEntity(store, second, signal);
  await collectHistory(store, first.objectId, 31 * 24 * 60 * 60 * 1000, signal);
  expect(await publishEntity(store, first, signal)).toEqual(published);
});

test('purging one provider leaves an independent plugin secret revision intact', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const provider = operation(crypto.randomUUID(), crypto.randomUUID(), 'provider-secret');
  const plugin = {
    ...operation(crypto.randomUUID(), crypto.randomUUID(), 'plugin-secret'),
    body: {
      kind: 'plugin-business' as const,
      logicalKey: '@example/plugin',
      value: { token: 'plugin-secret' },
      dependencies: [],
    },
  };
  const signal = new AbortController().signal;
  await publishEntity(store, provider, signal);
  await publishEntity(store, plugin, signal);
  await purgeEntity(store, provider.objectId, signal);
  const pluginRecord = new TextDecoder().decode(
    backend.readAll().get(revisionKey(plugin.objectId, plugin.operationId))!.value,
  );
  expect(pluginRecord).toContain('plugin-secret');
  expect(pluginRecord).not.toContain('provider-secret');
});

test('restore requires completed deletion and publishes in a new epoch', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'old');
  const signal = new AbortController().signal;
  await publishEntity(store, item, signal);
  await deleteEntity(store, item.objectId, 0, signal);
  const restored = await restoreEntity(store, item.objectId, item.body, crypto.randomUUID(), signal);
  expect(restored.sequence).toBe(2);
  expect(head(backend, item.objectId)).toMatchObject({ state: 'active', epoch: 1, current: restored.operationId });
});

test('server time uses the confirmed storage timestamp and recovers an unknown write', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const signal = new AbortController().signal;
  backend.failNext('compareAndSwap', 'after');
  const now = await readServerTime(store, signal);
  const value = backend.readAll().get('s/v1/default/space');
  expect(value?.kind).toBe('present');
  expect(now).toBe(value!.modifiedAt);
});

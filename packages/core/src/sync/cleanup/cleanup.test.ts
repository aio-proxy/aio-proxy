import { expect, test } from 'bun:test';

import type { SyncSession } from '@aio-proxy/plugin-sdk';

import {
  accountKey,
  beginPurge,
  decodeHead,
  decodeRevision,
  encode,
  entityKey,
  newHead,
  publish,
  reserve,
  revisionKey,
} from '../protocol';
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

function pauseEntityCas(backend: ReturnType<typeof createMemorySyncBackend>, objectId: string) {
  const base = backend.connect();
  let enter!: () => void;
  let release!: () => void;
  let paused = false;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session: SyncSession = {
    ...base,
    async compareAndSwap(key, expected, value, signal) {
      if (!paused && key === entityKey(objectId)) {
        paused = true;
        enter();
        await waiting;
      }
      return base.compareAndSwap(key, expected, value, signal);
    },
  };
  return { entered, release, store: createSyncObjectStore(session) };
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

test('purge fences a writer paused immediately before publication', async () => {
  const backend = createMemorySyncBackend();
  const item = operation(crypto.randomUUID());
  const signal = new AbortController().signal;
  const seed = backend.connect();
  const reserved = reserve(newHead(item.objectId, item.body), item.operationId, 0);
  await seed.compareAndSwap(entityKey(item.objectId), null, encode(reserved), signal);
  await seed.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    null,
    encode({
      protocol: 1,
      state: 'payload',
      objectId: item.objectId,
      epoch: 0,
      operationId: item.operationId,
      body: item.body,
      publishedSequence: null,
      writtenAt: null,
    }),
    signal,
  );
  const paused = pauseEntityCas(backend, item.objectId);
  const writer = publishEntity(paused.store, item, signal);
  await paused.entered;
  await purgeEntity(createSyncObjectStore(backend.connect()), item.objectId, signal);
  paused.release();
  await expect(writer).rejects.toMatchObject({ code: 'deleted' });
  const revision = decodeRevision(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value);
  expect(revision).toMatchObject({ state: 'erased', reason: 'purged' });
  expect(
    new TextDecoder().decode(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value),
  ).not.toContain('secret');
});

test('purge waits for account scrubbing after the purging marker is stored', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'account-secret');
  const signal = new AbortController().signal;
  await publishEntity(store, item, signal);
  await store.session.compareAndSwap(accountKey(item.objectId), null, encode({ token: 'account-secret' }), signal);
  const markerGate = backend.gateAfterNext('compareAndSwap');
  const purge = purgeEntity(createSyncObjectStore(backend.connect()), item.objectId, signal);
  await markerGate.entered;
  expect(head(backend, item.objectId).state).toBe('purging');
  expect(new TextDecoder().decode(backend.readAll().get(accountKey(item.objectId))!.value)).toContain('account-secret');
  markerGate.release();
  await purge;
  expect(new TextDecoder().decode(backend.readAll().get(accountKey(item.objectId))!.value)).not.toContain(
    'account-secret',
  );
});

test('purge resumes a purging head after a transient backend failure', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const signal = new AbortController().signal;
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'restart-secret');
  const reserved = reserve(newHead(item.objectId, item.body), item.operationId, 0);
  const purging = beginPurge(reserved);
  await session.compareAndSwap(entityKey(item.objectId), null, encode(purging), signal);
  backend.failNext('compareAndSwap', 'before');
  await expect(purgeEntity(createSyncObjectStore(backend.connect()), item.objectId, signal)).rejects.toMatchObject({
    code: 'offline',
  });
  await purgeEntity(createSyncObjectStore(backend.connect()), item.objectId, signal);
  expect(head(backend, item.objectId).state).toBe('purged');
});

test('a stale purge cannot overwrite a restored account after resuming', async () => {
  const backend = createMemorySyncBackend();
  const seed = backend.connect();
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'old-account-secret');
  const signal = new AbortController().signal;
  await publishEntity(createSyncObjectStore(seed), item, signal);
  await deleteEntity(createSyncObjectStore(seed), item.objectId, item.epoch, signal);
  await purgeEntity(createSyncObjectStore(seed), item.objectId, signal);
  const oldAccount = backend.readAll().get(accountKey(item.objectId));
  if (oldAccount?.kind !== 'present') throw new Error('missing account tombstone');
  await seed.compareAndSwap(
    accountKey(item.objectId),
    oldAccount.version,
    encode({
      protocol: 1,
      phase: 'ready',
      objectId: item.objectId,
      epoch: 0,
      generation: 1,
      credential: 'old-account-secret',
    }),
    signal,
  );

  const base = backend.connect();
  let paused = false;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const staleSession: SyncSession = {
    ...base,
    async compareAndSwap(key, expected, value, compareSignal) {
      if (!paused && key === accountKey(item.objectId)) {
        paused = true;
        enter();
        await waiting;
      }
      return base.compareAndSwap(key, expected, value, compareSignal);
    },
  };
  const stalePurge = purgeEntity(createSyncObjectStore(staleSession), item.objectId, signal);
  await entered;
  await restoreEntity(createSyncObjectStore(backend.connect()), item.objectId, item.body, 'restore-operation', signal);
  release();
  await stalePurge;

  const account = backend.readAll().get(accountKey(item.objectId));
  expect(account?.kind).toBe('present');
  const accountText = new TextDecoder().decode(account!.value);
  expect(accountText).toContain('"epoch":1');
  expect(accountText).not.toContain('old-account-secret');
  expect(head(backend, item.objectId)).toMatchObject({ state: 'active', epoch: 1 });
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
  expect(
    new TextDecoder().decode(backend.readAll().get(revisionKey(first.objectId, first.operationId))!.value),
  ).toContain('first');
  expect(
    new TextDecoder().decode(backend.readAll().get(revisionKey(first.objectId, second.operationId))!.value),
  ).toContain('second');
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

  const currentBackend = createMemorySyncBackend();
  const currentStore = createSyncObjectStore(currentBackend.connect());
  const current = operation(crypto.randomUUID(), crypto.randomUUID(), 'current');
  await publishEntity(currentStore, current, signal);
  currentBackend.advance(31 * 24 * 60 * 60 * 1000);
  await collectHistory(currentStore, current.objectId, 31 * 24 * 60 * 60 * 1000, signal);
  expect(head(currentBackend, current.objectId).current).toBe(current.operationId);
  expect(
    new TextDecoder().decode(currentBackend.readAll().get(revisionKey(current.objectId, current.operationId))!.value),
  ).toContain('current');
});

test('history cancels pending reservations and leaves no secret payload behind', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const signal = new AbortController().signal;
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'pending-secret');
  const reserved = reserve(newHead(item.objectId, item.body), item.operationId, 0);
  await session.compareAndSwap(entityKey(item.objectId), null, encode(reserved), signal);
  await session.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    null,
    encode({
      protocol: 1,
      state: 'payload',
      objectId: item.objectId,
      epoch: 0,
      operationId: item.operationId,
      body: item.body,
      publishedSequence: null,
      writtenAt: null,
    }),
    signal,
  );
  await collectHistory(createSyncObjectStore(session), item.objectId, 0, signal);
  expect(head(backend, item.objectId)).toMatchObject({ reserved: [], cancelling: [] });
  const marker = decodeRevision(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value);
  expect(marker).toMatchObject({ state: 'erased', reason: 'abandoned' });
  expect(
    new TextDecoder().decode(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value),
  ).not.toContain('pending-secret');
});

test('receipt finalization retries an unknown cleanup write', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const signal = new AbortController().signal;
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'receipt-secret');
  const reserved = reserve(newHead(item.objectId, item.body), item.operationId, 0);
  const headWrite = await session.compareAndSwap(entityKey(item.objectId), null, encode(reserved), signal);
  if (headWrite.kind !== 'written') throw new Error('head seed failed');
  await session.compareAndSwap(
    revisionKey(item.objectId, item.operationId),
    null,
    encode({
      protocol: 1,
      state: 'payload',
      objectId: item.objectId,
      epoch: 0,
      operationId: item.operationId,
      body: item.body,
      publishedSequence: null,
      writtenAt: null,
    }),
    signal,
  );
  const publishedHead = publish(reserved, item.operationId, 0);
  await session.compareAndSwap(entityKey(item.objectId), headWrite.version, encode(publishedHead), signal);
  backend.failNext('compareAndSwap', 'after');
  await collectHistory(createSyncObjectStore(session), item.objectId, 0, signal);
  const revision = decodeRevision(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value);
  expect(revision).toMatchObject({ state: 'payload', publishedSequence: 1, writtenAt: 0 });
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

test('restore preserves a recovered same-epoch account payload', async () => {
  const backend = createMemorySyncBackend();
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'old');
  const signal = new AbortController().signal;
  const seed = createSyncObjectStore(backend.connect());
  await publishEntity(seed, item, signal);
  await deleteEntity(seed, item.objectId, 0, signal);

  const headCas = backend.gateAfterNext('compareAndSwap');
  const restore = restoreEntity(
    createSyncObjectStore(backend.connect()),
    item.objectId,
    item.body,
    crypto.randomUUID(),
    signal,
  );
  await headCas.entered;
  const account = backend.readAll().get(accountKey(item.objectId));
  if (account?.kind !== 'present') throw new Error('missing account tombstone');
  const recovered = encode({
    protocol: 1,
    phase: 'ready',
    objectId: item.objectId,
    epoch: 1,
    generation: 7,
    credential: 'recovered-secret',
  });
  const write = await backend.connect().compareAndSwap(accountKey(item.objectId), account.version, recovered, signal);
  expect(write.kind).toBe('written');
  headCas.release();

  await restore;
  const value = backend.readAll().get(accountKey(item.objectId));
  expect(value?.kind).toBe('present');
  expect(new TextDecoder().decode(value!.value)).toContain('recovered-secret');
  expect(new TextDecoder().decode(value!.value)).toContain('"generation":7');
});

test('restore cannot write an active account fence after concurrent deletion', async () => {
  const backend = createMemorySyncBackend();
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'old');
  const signal = new AbortController().signal;
  const seed = createSyncObjectStore(backend.connect());
  await publishEntity(seed, item, signal);
  await deleteEntity(seed, item.objectId, 0, signal);

  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const base = backend.connect();
  let paused = false;
  const restoreSession: SyncSession = {
    ...base,
    async compareAndSwap(key, expected, value, compareSignal) {
      if (!paused && key === accountKey(item.objectId)) {
        paused = true;
        entered();
        await waiting;
      }
      return base.compareAndSwap(key, expected, value, compareSignal);
    },
  };
  const restore = restoreEntity(
    createSyncObjectStore(restoreSession),
    item.objectId,
    item.body,
    crypto.randomUUID(),
    signal,
  );
  await enteredPromise;
  await deleteEntity(createSyncObjectStore(backend.connect()), item.objectId, 1, signal);
  release();

  await expect(restore).rejects.toMatchObject({ code: 'deleted' });
  const value = backend.readAll().get(accountKey(item.objectId));
  expect(value?.kind).toBe('present');
  expect(new TextDecoder().decode(value!.value)).toContain('"phase":"deleted"');
  expect(head(backend, item.objectId)).toMatchObject({ state: 'deleted', epoch: 1 });
});

test('restore cannot write an active account fence after concurrent purge', async () => {
  const backend = createMemorySyncBackend();
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'old');
  const signal = new AbortController().signal;
  const seed = createSyncObjectStore(backend.connect());
  await publishEntity(seed, item, signal);
  await deleteEntity(seed, item.objectId, 0, signal);

  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const base = backend.connect();
  let paused = false;
  const restoreSession: SyncSession = {
    ...base,
    async compareAndSwap(key, expected, value, compareSignal) {
      if (!paused && key === accountKey(item.objectId)) {
        paused = true;
        entered();
        await waiting;
      }
      return base.compareAndSwap(key, expected, value, compareSignal);
    },
  };
  const restore = restoreEntity(
    createSyncObjectStore(restoreSession),
    item.objectId,
    item.body,
    crypto.randomUUID(),
    signal,
  );
  await enteredPromise;
  await purgeEntity(createSyncObjectStore(backend.connect()), item.objectId, signal);
  release();

  await expect(restore).rejects.toMatchObject({ code: 'deleted' });
  const value = backend.readAll().get(accountKey(item.objectId));
  expect(value?.kind).toBe('present');
  expect(new TextDecoder().decode(value!.value)).toContain('"phase":"deleted"');
  expect(head(backend, item.objectId)).toMatchObject({ state: 'purged', epoch: 1 });
});

test('restore retains the prior current in history so retention can expire it', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'old-secret');
  const signal = new AbortController().signal;
  await publishEntity(store, item, signal);
  await deleteEntity(store, item.objectId, 0, signal);
  const restored = await restoreEntity(store, item.objectId, item.body, crypto.randomUUID(), signal);
  expect(head(backend, item.objectId).history).toContain(item.operationId);
  await collectHistory(store, item.objectId, 31 * 24 * 60 * 60 * 1000, signal);
  expect(head(backend, item.objectId).history).not.toContain(item.operationId);
  const old = new TextDecoder().decode(backend.readAll().get(revisionKey(item.objectId, item.operationId))!.value);
  expect(old).toMatch(/"state":"erased"/);
  expect(old).not.toContain('old-secret');
  expect(head(backend, item.objectId).current).toBe(restored.operationId);
});

test('purge after restore erases retained revisions from both epochs', async () => {
  const backend = createMemorySyncBackend();
  const store = createSyncObjectStore(backend.connect());
  const item = operation(crypto.randomUUID(), crypto.randomUUID(), 'old-secret');
  const signal = new AbortController().signal;
  await publishEntity(store, item, signal);
  await deleteEntity(store, item.objectId, 0, signal);
  const restored = await restoreEntity(
    store,
    item.objectId,
    { ...item.body, value: { apiKey: 'new-secret' } },
    crypto.randomUUID(),
    signal,
  );
  await purgeEntity(store, item.objectId, signal);
  expect(head(backend, item.objectId).state).toBe('purged');
  const records = [...backend.readAll().entries()]
    .filter(([key]) => key.startsWith(`s/v1/default/revision/${item.objectId}/`))
    .map(([, value]) => (value.kind === 'present' ? new TextDecoder().decode(value.value) : ''))
    .join('\n');
  expect(records).not.toContain('old-secret');
  expect(records).not.toContain('new-secret');
  expect(records).toContain(`"operationId":"${restored.operationId}"`);
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

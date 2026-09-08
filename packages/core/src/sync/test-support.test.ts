import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { exerciseSyncBackend } from '@aio-proxy/plugin-sdk/testing';

import { MIGRATIONS } from '../db/migrations.manifest';
import { DatabaseSchemaTooNewError } from '../error';
import { createMemorySyncBackend, migrateSyncTestDb } from './test-support';

test('memory sync backend satisfies the public conformance exercise', async () => {
  const backend = createMemorySyncBackend();
  const a = backend.connect();
  const b = backend.connect();

  await exerciseSyncBackend(async () => ({
    a,
    b,
    async cleanup() {
      await Promise.allSettled([a.dispose(), b.dispose()]);
    },
  }));
});

test('memory backend persists a write before an outcome-unknown failure', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const signal = new AbortController().signal;
  backend.failNext('compareAndSwap', 'after');

  await expect(session.compareAndSwap('key', null, new Uint8Array([1]), signal)).rejects.toMatchObject({
    code: 'outcome-unknown',
  });
  expect(await session.read('key', signal)).toMatchObject({ kind: 'present', value: new Uint8Array([1]) });
});

test('disposing a gated session cancels its in-flight read and CAS without affecting other sessions', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const casSession = backend.connect();
  const other = backend.connect();
  const signal = new AbortController().signal;

  const readGate = backend.gateNext('read');
  const pendingRead = session.read('read-key', signal);
  await readGate.entered;
  await session.dispose();
  readGate.release();
  await expect(pendingRead).rejects.toMatchObject({ code: 'cancelled' });

  const casGate = backend.gateNext('compareAndSwap');
  const pendingCas = casSession.compareAndSwap('cas-key', null, new Uint8Array([1]), signal);
  await casGate.entered;
  await casSession.dispose();
  casGate.release();
  await expect(pendingCas).rejects.toMatchObject({ code: 'cancelled' });
  expect(backend.readAll().has('cas-key')).toBe(false);

  await expect(other.compareAndSwap('other-key', null, new Uint8Array([2]), signal)).resolves.toMatchObject({
    kind: 'written',
  });
});

test('migration test support rejects a database newer than the compiled schema', () => {
  const db = new Database(':memory:');
  db.run(`PRAGMA user_version = ${(MIGRATIONS.at(-1)?.version ?? 0) + 1}`);
  expect(() => migrateSyncTestDb(db)).toThrow(DatabaseSchemaTooNewError);
  db.close();
});

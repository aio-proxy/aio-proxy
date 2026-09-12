import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityBody } from '../protocol';
import { migrateSyncTestDb } from '../test-support';
import { createSyncRepository, type LocalBinding, type LocalEntity } from './repository';

const body: EntityBody = {
  kind: 'provider',
  logicalKey: 'work',
  value: { kind: 'api', baseUrl: 'https://example.test' },
  dependencies: [],
};

const binding = (id: string): LocalBinding => ({
  id,
  plugin: '@example/sync',
  capability: 'memory',
  pluginVersion: '1.0.0',
  identityId: `identity-${id}`,
  spaceId: 'default',
  deviceId: `device-${id}`,
  sessionGeneration: 1,
  options: { local: true },
});

const entity = (objectId: string): LocalEntity => ({
  objectId,
  logicalKey: 'work',
  kind: 'provider',
  mode: 'included',
  epoch: 2,
  desired: body,
  baseline: 'old-operation',
  overrides: [{ path: ['value', 'baseUrl'], value: 'https://local.test' }],
  pendingReason: null,
});

function intent(origin: 'local' | 'remote' = 'local') {
  return {
    commitId: `${origin}-commit`,
    origin,
    beforeDigest: 'before',
    afterDigest: 'after',
    rawAfter: { providers: {} },
    accountOperationIds: [],
    phase: 'prepared' as const,
    ...(origin === 'remote' ? { remoteOperations: [{ objectId: 'object-1', operationId: 'remote-op' }] } : {}),
  };
}

test('confirmed remote imports do not enter the outbox after restart', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.prepare('b', intent('remote'));
  repo.confirm('b', 'remote-commit', []);
  expect(createSyncRepository(db).outbox('b')).toEqual([]);
  expect(repo.pendingCommits('b')).toEqual([]);
  db.close();
});

test('binding switches preserve old rows while exposing one active binding', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.writeBinding(binding('old'));
  repo.writeOAuthJournal('old', {
    operationId: 'oauth-old',
    objectId: 'account-old',
    epoch: 1,
    baseGeneration: 1,
    phase: 'complete',
    payload: { token: 'local' },
  });
  repo.writeBinding(binding('new'));
  expect(repo.readBinding()).toEqual(binding('new'));
  expect(repo.oauthJournals('old')).toHaveLength(1);
  expect(db.query('SELECT active FROM sync_binding WHERE id = ?').get('old')).toEqual({ active: 0 });
  db.close();
});

test('disconnecting keeps the retired binding OAuth ownership and journal', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.writeBinding(binding('old'));
  repo.putEntity('old', {
    ...entity('shared-object'),
    oauth: { mode: 'shared', epoch: 2, generation: 1, localRevision: 1, pluginVersion: '1.0.0', formatVersion: 1 },
  });
  repo.writeOAuthJournal('old', {
    operationId: 'oauth-inflight',
    objectId: 'shared-object',
    epoch: 1,
    baseGeneration: 1,
    phase: 'started',
    payload: null,
  });

  repo.clearBinding!();

  // Ownership is the only durable record that other devices follow this credential. Erasing it
  // would let the ordinary local port rotate the refresh token with no cloud coordination and
  // invalidate the other devices; the retire paths refuse instead, so it survives here.
  expect(repo.entities('old')[0]?.oauth?.mode).toBe('shared');
  expect(repo.oauthJournals('old')).toHaveLength(1);
  expect(repo.readBinding()).toBeNull();
  db.close();
});

test('binding identity changes under the same ID are rejected without losing old rows', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.writeBinding(binding('same'));
  repo.writeOAuthJournal('same', {
    operationId: 'oauth-same',
    objectId: 'account-same',
    epoch: 0,
    baseGeneration: 1,
    phase: 'complete',
    payload: { token: 'retained' },
  });
  expect(() => repo.writeBinding({ ...binding('same'), capability: 'other' })).toThrow();
  expect(repo.readBinding()).toEqual(binding('same'));
  expect(repo.oauthJournals('same')).toHaveLength(1);
  repo.writeBinding({ ...binding('same'), sessionGeneration: 2, options: { changed: true } });
  expect(repo.readBinding()).toMatchObject({ sessionGeneration: 2, options: { changed: true } });
  db.close();
});

test('local confirmation persists operations, source revisions, and remote baselines atomically', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.putEntity('b', entity('object-1'));
  repo.prepare('b', intent());
  repo.confirm(
    'b',
    'local-commit',
    [{ operationId: 'operation-1', objectId: 'object-1', epoch: 2, kind: 'put', body, commitId: 'local-commit' }],
    { account: 7, secret: 8 },
  );
  expect(repo.outbox('b')).toEqual([
    { operationId: 'operation-1', objectId: 'object-1', epoch: 2, kind: 'put', body, commitId: 'local-commit' },
  ]);
  expect(repo.readCommit('b', 'local-commit')).toMatchObject({
    phase: 'confirmed',
    sourceRevisions: { account: 7, secret: 8 },
  });
  expect(repo.latestConfirmedCommit('b')?.commitId).toBe('local-commit');
  expect(repo.entities('b')[0]?.baseline).toBe('old-operation');

  repo.prepare('b', intent('remote'));
  repo.confirm('b', 'remote-commit', []);
  expect(repo.entities('b')[0]?.baseline).toBe('remote-op');
  db.close();
});

test('remote confirmation rejects outbox operations and leaves the intent pending', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.prepare('b', intent('remote'));
  expect(() =>
    repo.confirm('b', 'remote-commit', [
      {
        operationId: 'operation-1',
        objectId: 'object-1',
        epoch: 1,
        kind: 'delete',
        body: null,
        commitId: 'remote-commit',
      },
    ]),
  ).toThrow();
  expect(repo.readCommit('b', 'remote-commit')?.phase).toBe('prepared');
  expect(repo.outbox('b')).toEqual([]);
  db.close();
});

test('outbox operation ID conflicts are rejected instead of being ignored', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.prepare('b', intent());
  repo.confirm('b', 'local-commit', [
    { operationId: 'operation-1', objectId: 'object-1', epoch: 1, kind: 'put', body, commitId: 'local-commit' },
  ]);
  repo.prepare('b', { ...intent(), commitId: 'second-commit', afterDigest: 'second' });
  expect(() =>
    repo.confirm('b', 'second-commit', [
      {
        operationId: 'operation-1',
        objectId: 'object-2',
        epoch: 2,
        kind: 'delete',
        body: null,
        commitId: 'second-commit',
      },
    ]),
  ).toThrow();
  expect(repo.readCommit('b', 'second-commit')?.phase).toBe('prepared');
  expect(repo.outbox('b')).toHaveLength(1);
  db.close();
});

test('repeated prepare with conflicting intent data is rejected', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.prepare('b', intent());
  expect(() => repo.prepare('b', { ...intent(), afterDigest: 'different' })).toThrow();
  expect(repo.readCommit('b', 'local-commit')?.afterDigest).toBe('after');
  db.close();
});

test('OAuth journal writes are idempotent and enforce identity, phase, and result monotonicity', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  const started = {
    operationId: 'oauth-1',
    objectId: 'account-1',
    epoch: 1,
    baseGeneration: 3,
    phase: 'started' as const,
    payload: null,
  };
  repo.writeOAuthJournal('b', started);
  repo.writeOAuthJournal('b', started);
  expect(Number(db.query('PRAGMA synchronous').get()?.synchronous)).toBe(2);
  const result = { ...started, phase: 'result' as const, payload: { token: 'new' } };
  repo.writeOAuthJournal('b', result);
  repo.writeOAuthJournal('b', result);
  expect(() => repo.writeOAuthJournal('b', started)).toThrow();
  expect(() => repo.writeOAuthJournal('b', { ...result, payload: { token: 'other' } })).toThrow();
  expect(() => repo.writeOAuthJournal('b', { ...result, objectId: 'account-2' })).toThrow();
  repo.writeOAuthJournal('b', { ...result, phase: 'complete' });
  expect(repo.oauthJournals('b')).toEqual([{ ...result, phase: 'complete' }]);
  db.close();
});

test('completed OAuth journal results can be cleared without retaining credentials', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  const completed = {
    operationId: 'oauth-clear',
    objectId: 'account-clear',
    epoch: 1,
    baseGeneration: 2,
    phase: 'complete' as const,
    payload: { accessToken: 'secret-to-clear' },
  };
  repo.writeOAuthJournal('b', completed);
  repo.clearOAuthJournal('b', completed.operationId);
  expect(repo.oauthJournals('b')).toEqual([]);
  expect(db.query('SELECT * FROM sync_oauth_journal').all()).toEqual([]);
  repo.writeOAuthJournal('b', { ...completed, phase: 'started', payload: null });
  expect(repo.oauthJournals('b')).toEqual([{ ...completed, phase: 'started', payload: null }]);
  db.close();
});

test('a failed confirm rolls back earlier outbox inserts', () => {
  const db = new Database(':memory:');
  migrateSyncTestDb(db);
  const repo = createSyncRepository(db);
  repo.prepare('b', intent());
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() =>
    repo.confirm('b', 'local-commit', [
      { operationId: 'operation-1', objectId: 'object-1', epoch: 1, kind: 'put', body, commitId: 'local-commit' },
      {
        operationId: 'operation-2',
        objectId: 'object-2',
        epoch: 1,
        kind: 'put',
        body: circular as never,
        commitId: 'local-commit',
      },
    ]),
  ).toThrow();
  expect(repo.readCommit('b', 'local-commit')?.phase).toBe('prepared');
  expect(repo.outbox('b')).toEqual([]);
  db.close();
});

test('repository state survives reopening an on-disk database', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-repository-'));
  const path = join(home, 'sync.db');
  try {
    const first = new Database(path);
    migrateSyncTestDb(first);
    const repo = createSyncRepository(first);
    repo.writeBinding(binding('persisted'));
    repo.putEntity('persisted', entity('object-1'));
    repo.writeOAuthJournal('persisted', {
      operationId: 'oauth-1',
      objectId: 'account-1',
      epoch: 0,
      baseGeneration: 1,
      phase: 'result',
      payload: { value: { accessToken: 'current-only' }, metadata: { expiresAt: 42 } },
    });
    repo.prepare('persisted', intent());
    repo.confirm('persisted', 'local-commit', [
      { operationId: 'operation-1', objectId: 'object-1', epoch: 2, kind: 'put', body, commitId: 'local-commit' },
    ]);
    first.close();

    const second = new Database(path);
    const reopened = createSyncRepository(second);
    expect(reopened.readBinding()).toEqual(binding('persisted'));
    expect(reopened.entities('persisted')).toEqual([entity('object-1')]);
    expect(reopened.oauthJournals('persisted')).toEqual([
      {
        operationId: 'oauth-1',
        objectId: 'account-1',
        epoch: 0,
        baseGeneration: 1,
        phase: 'result',
        payload: { value: { accessToken: 'current-only' }, metadata: { expiresAt: 42 } },
      },
    ]);
    expect(reopened.latestConfirmedCommit('persisted')?.commitId).toBe('local-commit');
    expect(reopened.outbox('persisted')).toHaveLength(1);
    second.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

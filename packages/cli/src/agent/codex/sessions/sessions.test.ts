import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from '../location';
import { acquireSessionLock } from './journal';
import { rewriteLegacyProvider } from './legacy-rollout';
import { restoreCodexMigration } from './restore';
import { inspectCodexSessions, migrateCodexSessions, setSessionTestDeps } from './sessions';

const id = '11111111-1111-4111-8111-111111111111';
const rollout = (provider: string, extra = '') =>
  `${JSON.stringify({ type: 'turn_context', payload: { model_provider: provider } })}\n${JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } })}\n${extra}`;

async function prepareMarker(location: ReturnType<typeof resolveCodexLocation>): Promise<void> {
  await mkdir(location.managedRoot, { recursive: true });
  await writeFile(
    location.markerPath,
    JSON.stringify({ format: 1, managedBy: 'aio-proxy', configPath: location.configPath, providerId: 'aio-proxy' }),
  );
  await writeFile(location.configPath, 'model_provider = "aio-proxy"\n');
}

afterEach(() => setSessionTestDeps({}));

test('changes only session Provider metadata, never matching conversation text', () => {
  const header = JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'old' } });
  const tail = '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'old', model: 'keep' } }) + '\n';
  const result = new TextDecoder().decode(
    rewriteLegacyProvider(new TextEncoder().encode(header + tail), id, 'old', 'aio-proxy'),
  );
  expect(JSON.parse(result.split('\n')[0]!).payload.model_provider).toBe('aio-proxy');
  expect(result.slice(result.indexOf('\n'))).toBe(tail);
  const special = new TextDecoder().decode(
    rewriteLegacyProvider(new TextEncoder().encode(header + tail), id, 'old', '$&-provider'),
  );
  expect(JSON.parse(special.split('\n')[0]!).payload.model_provider).toBe('$&-provider');
});

test('previews, migrates, and explicitly restores a legacy session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location);
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'non-standard-history-name.jsonl');
    const original = rollout('source-proxy', '{"type":"response_item","payload":{"text":"keep"}}\n');
    await writeFile(rolloutPath, original);
    let db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT, model TEXT, title TEXT, parent_thread_id TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'source-proxy',
      'legacy',
      0,
      rolloutPath,
      'model',
      'title',
      null,
    );
    db.close();
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
    const preview = await inspectCodexSessions(location);
    expect(preview.groups).toEqual([{ providerId: 'source-proxy', active: 1, archived: 0 }]);
    expect(preview.targets).toHaveLength(1);
    const migrated = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(migrated.status).toBe('completed');
    expect(
      (db = new Database(join(root, 'state_5.sqlite')))
        .query('SELECT model_provider FROM threads WHERE id = ?')
        .get(id),
    ).toEqual({ model_provider: 'aio-proxy' });
    expect(db.query('SELECT model, title, parent_thread_id FROM threads WHERE id = ?').get(id)).toEqual({
      model: 'model',
      title: 'title',
      parent_thread_id: null,
    });
    expect(new TextDecoder().decode(new Uint8Array(await readFile(rolloutPath)))).toContain(
      '"model_provider":"aio-proxy"',
    );
    const restored = await restoreCodexMigration(location, migrated.operationId!);
    expect(restored.status).toBe('completed');
    expect(new TextDecoder().decode(new Uint8Array(await readFile(rolloutPath)))).toContain('"text":"keep"');
    expect(new TextDecoder().decode(new Uint8Array(await readFile(rolloutPath)))).toContain(
      '"model_provider":"source-proxy"',
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls back a replacement failure and restores a committed operation after later content is appended', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-failure-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location);
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'history.jsonl');
    await writeFile(rolloutPath, rollout('source-proxy'));
    let db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'legacy', 0, rolloutPath);
    db.close();
    setSessionTestDeps({
      offlineCheck: async () => 'ok',
      afterFirstReplacement: async () => {
        throw new Error('stop');
      },
    });
    const preview = await inspectCodexSessions(location);
    const failed = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(failed.status).toBe('blocked');
    expect(new TextDecoder().decode(new Uint8Array(await readFile(rolloutPath)))).toContain('source-proxy');
    db = new Database(join(root, 'state_5.sqlite'));
    expect(db.query('SELECT model_provider FROM threads WHERE id = ?').get(id)).toEqual({
      model_provider: 'source-proxy',
    });
    db.close();

    setSessionTestDeps({
      offlineCheck: async () => 'ok',
      beforeCommit: async () => {
        throw new Error('before commit');
      },
    });
    const beforeCommit = await migrateCodexSessions({
      location,
      targets: preview.targets,
      targetProviderId: 'aio-proxy',
    });
    expect(beforeCommit.status).toBe('blocked');
    expect(await readFile(rolloutPath, 'utf8')).toContain('source-proxy');

    setSessionTestDeps({
      offlineCheck: async () => 'ok',
      afterCommit: async () => {
        throw new Error('restart');
      },
    });
    const committed = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(committed.status).toBe('partial');
    await writeFile(
      rolloutPath,
      `${await readFile(rolloutPath, 'utf8')}\n{"type":"response_item","payload":{"text":"later"}}\n`,
    );
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
    const restored = await restoreCodexMigration(location, committed.operationId!);
    expect(restored.status).toBe('completed');
    const restoredText = await readFile(rolloutPath, 'utf8');
    expect(restoredText).toContain('source-proxy');
    expect(restoredText).toContain('later');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks unverified formats, duplicate IDs, and an invalid managed marker without leaking paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-blocked-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await mkdir(location.managedRoot, { recursive: true });
    await writeFile(location.markerPath, '{not-json');
    const invalidMarker = await inspectCodexSessions(location);
    expect(invalidMarker.blocked.some((item) => item.reason.includes('managed_marker'))).toBe(true);
    expect(JSON.stringify(invalidMarker)).not.toContain(root);

    await prepareMarker(location);
    const rolloutPath = join(root, 'sessions', 'history.jsonl');
    const secondRolloutPath = join(root, 'sessions', 'history-2.jsonl');
    await mkdir(join(root, 'sessions'), { recursive: true });
    await writeFile(rolloutPath, rollout('source-proxy'));
    await writeFile(secondRolloutPath, rollout('source-proxy'));
    const db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'paginated', 0, rolloutPath);
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'legacy', 0, rolloutPath);
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'legacy', 0, secondRolloutPath);
    db.close();
    const preview = await inspectCodexSessions(location);
    expect(preview.blocked.map((item) => item.reason)).toContain(
      'paginated history format is not verified for offline migration',
    );
    expect(preview.blocked.map((item) => item.reason)).toContain('duplicate_session_id');
    expect(preview.targets).toHaveLength(0);
    expect(JSON.stringify(preview)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a stale migration lease and blocks when the offline check is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-lease-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await mkdir(join(location.managedRoot, 'migrations', '.lock'), { recursive: true });
    await writeFile(
      join(location.managedRoot, 'migrations', '.lock', 'owner.json'),
      JSON.stringify({ pid: 9999999, token: '00000000-0000-4000-8000-000000000000', expiresAt: 1 }),
    );
    const lock = await acquireSessionLock(location);
    expect(lock.token).not.toBe('00000000-0000-4000-8000-000000000000');
    await lock.release();
    await prepareMarker(location);
    setSessionTestDeps({ offlineCheck: async () => 'offline_check_unavailable' });
    const result = await migrateCodexSessions({
      location,
      targets: [{ id, sourceProviderId: 'source-proxy', archived: false, storage: 'legacy', revision: '0'.repeat(64) }],
      targetProviderId: 'aio-proxy',
    });
    expect(result.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not commit an index restore when the rollout has a third provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-conflict-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location);
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'history.jsonl');
    await writeFile(rolloutPath, rollout('source-proxy'));
    let db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'legacy', 0, rolloutPath);
    db.close();
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
    const preview = await inspectCodexSessions(location);
    const migrated = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    await writeFile(rolloutPath, (await readFile(rolloutPath, 'utf8')).replace('aio-proxy', 'third-party'));
    const restored = await restoreCodexMigration(location, migrated.operationId!);
    expect(restored.status).toBe('partial');
    db = new Database(join(root, 'state_5.sqlite'));
    expect(db.query('SELECT model_provider FROM threads WHERE id = ?').get(id)).toEqual({
      model_provider: 'aio-proxy',
    });
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('journals the pre-log interruption without writing session data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-prelog-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location);
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'history.jsonl');
    await writeFile(rolloutPath, rollout('source-proxy'));
    const db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'legacy', 0, rolloutPath);
    db.close();
    setSessionTestDeps({
      offlineCheck: async () => 'ok',
      beforeLog: async () => {
        throw new Error('stop');
      },
    });
    const preview = await inspectCodexSessions(location);
    const result = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(result.status).toBe('blocked');
    expect(await readFile(rolloutPath, 'utf8')).toContain('source-proxy');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from '../location';
import { rewriteLegacyProvider } from './legacy-rollout';
import { inspectCodexSessions, migrateCodexSessions, restoreCodexMigration, setSessionTestDeps } from './sessions';

const id = '11111111-1111-4111-8111-111111111111';
const rollout = (provider: string, extra = '') =>
  `${JSON.stringify({ type: 'turn_context', payload: { model_provider: provider } })}\n${JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } })}\n${extra}`;

afterEach(() => setSessionTestDeps({}));

test('changes only session Provider metadata, never matching conversation text', () => {
  const header = JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'old' } });
  const tail = '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'old', model: 'keep' } }) + '\n';
  const result = new TextDecoder().decode(
    rewriteLegacyProvider(new TextEncoder().encode(header + tail), id, 'old', 'aio-proxy'),
  );
  expect(JSON.parse(result.split('\n')[0]!).payload.model_provider).toBe('aio-proxy');
  expect(result.slice(result.indexOf('\n'))).toBe(tail);
});

test('previews, migrates, and explicitly restores a legacy session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root });
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
    const location = resolveCodexLocation(root, { HOME: root });
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

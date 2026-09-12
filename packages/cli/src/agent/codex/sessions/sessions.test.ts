import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from '../location';
import { acquireSessionLock } from './journal';
import { inspectLegacyMetadata, rewriteLegacyProvider } from './legacy-rollout';
import { restoreCodexMigration } from './restore';
import { inspectCodexSessions, isCodexWriterProcess, migrateCodexSessions, setSessionTestDeps } from './sessions';

const id = '11111111-1111-4111-8111-111111111111';
const rollout = (provider: string, extra = '') =>
  `${JSON.stringify({ type: 'turn_context', payload: { model_provider: provider } })}\n${JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } })}\n${extra}`;

async function prepareMarker(
  location: ReturnType<typeof resolveCodexLocation>,
  mode: 'v1' | 'v2-command' = 'v1',
): Promise<void> {
  await mkdir(location.managedRoot, { recursive: true });
  const command = '/tmp/aio-proxy/aiop';
  const provider = {
    name: 'AIO Proxy',
    base_url: 'http://127.0.0.1:9317/v1',
    wire_api: 'responses',
    requires_openai_auth: mode === 'v1' ? true : undefined,
    experimental_bearer_token: mode === 'v1' ? 'aio-proxy-local' : undefined,
  };
  const fields = [
    { path: ['model_provider'], before: { present: false }, applied: { present: true, value: 'aio-proxy' } },
    ...Object.entries(provider).map(([field, value]) => ({
      path: ['model_providers', 'aio-proxy', field],
      before: { present: false },
      applied: value === undefined ? { present: false } : { present: true, value },
    })),
  ];
  if (mode === 'v2-command') {
    fields.push(
      ...[
        ['command', command],
        ['args', ['agent', 'auth', 'codex', '--installation-id', id]],
        ['timeout_ms', 5000],
        ['refresh_interval_ms', 300000],
      ].map(([field, value]) => ({
        path: ['model_providers', 'aio-proxy', 'auth', field as string],
        before: { present: false },
        applied: { present: true, value },
      })),
    );
  }
  await writeFile(
    location.markerPath,
    JSON.stringify({
      format: mode === 'v1' ? 1 : 2,
      managedBy: 'aio-proxy',
      configPath: location.configPath,
      providerId: 'aio-proxy',
      fields,
      createdTables: [
        ['model_providers', 'aio-proxy'],
        ...(mode === 'v2-command' ? [['model_providers', 'aio-proxy', 'auth']] : []),
      ],
      ...(mode === 'v2-command' ? { authMode: 'command', installationId: id } : {}),
    }),
  );
  await writeFile(
    location.configPath,
    `model_provider = "aio-proxy"\n\n[model_providers.aio-proxy]\n${Object.entries(provider)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => `${field} = ${JSON.stringify(value)}`)
      .join('\n')}\n${
      mode === 'v2-command'
        ? `\n[model_providers.aio-proxy.auth]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify([
            'agent',
            'auth',
            'codex',
            '--installation-id',
            id,
          ])}\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n`
        : ''
    }`,
  );
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

test('accepts the Task 1 legacy rollout fixture shape and preserves opaque records', async () => {
  const bytes = new Uint8Array(
    await Bun.file(new URL('./fixtures/legacy-session.jsonl', import.meta.url)).arrayBuffer(),
  );
  const original = new TextDecoder().decode(bytes);
  const result = new TextDecoder().decode(rewriteLegacyProvider(bytes, id, 'source-proxy', 'aio-proxy'));
  const originalLines = original.split('\n');
  const resultLines = result.split('\n');
  const metadataLine = inspectLegacyMetadata(bytes).line;
  expect(resultLines).toHaveLength(originalLines.length);
  for (let line = 0; line < originalLines.length; line += 1)
    if (line !== metadataLine) expect(resultLines[line]).toBe(originalLines[line]);
  expect(JSON.parse(resultLines[metadataLine]!).payload.model_provider).toBe('aio-proxy');
  expect(result).toContain('"type":"function_call_output"');
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
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT, model TEXT, title TEXT, parent_thread_id TEXT, created_at INTEGER)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'source-proxy',
      'legacy',
      0,
      rolloutPath,
      'model',
      'title',
      null,
      1700000000,
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
    expect(db.query('SELECT model, title, parent_thread_id, created_at FROM threads WHERE id = ?').get(id)).toEqual({
      model: 'model',
      title: 'title',
      parent_thread_id: null,
      created_at: 1700000000,
    });
    expect(new TextDecoder().decode(new Uint8Array(await readFile(rolloutPath)))).toContain(
      '"model_provider":"aio-proxy"',
    );
    const repeated = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(repeated.migrated).toBe(0);
    expect(repeated.operationId).toBeUndefined();
    const restored = await restoreCodexMigration(location, migrated.operationId!);
    expect(restored.status).toBe('completed');
    expect((await restoreCodexMigration(location, migrated.operationId!)).status).toBe('completed');
    expect(new TextDecoder().decode(new Uint8Array(await readFile(rolloutPath)))).toContain('"text":"keep"');
    expect(new TextDecoder().decode(new Uint8Array(await readFile(rolloutPath)))).toContain(
      '"model_provider":"source-proxy"',
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('previews existing history before the first managed marker is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-first-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'first-history.jsonl');
    await writeFile(rolloutPath, rollout('openai'));
    const db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT, model TEXT, title TEXT, parent_thread_id TEXT, created_at INTEGER)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'openai',
      'legacy',
      0,
      rolloutPath,
      'model',
      'title',
      null,
      1700000000,
    );
    db.close();
    setSessionTestDeps({ offlineCheck: async () => 'ok' });

    const preview = await inspectCodexSessions(location, 'custom');
    expect(preview.blocked).toEqual([]);
    expect(preview.groups).toEqual([{ providerId: 'openai', active: 1, archived: 0 }]);
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0]?.sourceProviderId).toBe('openai');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('previews and migrates ordinary legacy history using config-declared sqlite_home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-config-sqlite-'));
  try {
    await writeFile(join(root, 'config.toml'), 'sqlite_home = "state"\n');
    const location = resolveCodexLocation(root, { HOME: root });
    await prepareMarker(location);
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'ordinary-history.jsonl');
    await writeFile(rolloutPath, rollout('source-proxy'));
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
    const preview = await inspectCodexSessions(location);
    expect(preview.blocked).toEqual([]);
    expect(preview.targets).toHaveLength(1);
    const migrated = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(migrated.status).toBe('completed');
    expect(await readFile(rolloutPath, 'utf8')).toContain('"model_provider":"aio-proxy"');
    const restored = await restoreCodexMigration(location, migrated.operationId!);
    expect(restored.status).toBe('completed');
    expect(await readFile(rolloutPath, 'utf8')).toContain('"model_provider":"source-proxy"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates legacy history with a V2 command-auth marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-v2-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location, 'v2-command');
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'v2-history.jsonl');
    await writeFile(rolloutPath, rollout('source-proxy'));
    const db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'legacy', 0, rolloutPath);
    db.close();
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
    const preview = await inspectCodexSessions(location);
    expect(preview.blocked).toEqual([]);
    const migrated = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(migrated.status).toBe('completed');
    expect(await readFile(rolloutPath, 'utf8')).toContain('"model_provider":"aio-proxy"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks migration for a symlinked or partial managed marker without leaking its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-marker-safety-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location, 'v2-command');
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'marker-safety.jsonl');
    await writeFile(rolloutPath, rollout('source-proxy'));
    const db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, 'source-proxy', 'legacy', 0, rolloutPath);
    db.close();
    setSessionTestDeps({ offlineCheck: async () => 'ok' });

    const markerCopy = join(root, 'marker-copy.json');
    await writeFile(markerCopy, await readFile(location.markerPath));
    await rm(location.markerPath);
    await symlink(markerCopy, location.markerPath);
    const symlinked = await migrateCodexSessions({
      location,
      targets: [{ id, sourceProviderId: 'source-proxy', archived: false, storage: 'legacy', revision: '0'.repeat(64) }],
      targetProviderId: 'aio-proxy',
    });
    expect(symlinked.status).toBe('blocked');
    expect(JSON.stringify(symlinked)).not.toContain(root);
    expect(await readFile(rolloutPath, 'utf8')).toContain('source-proxy');

    await rm(location.markerPath);
    const partial = JSON.parse(await readFile(markerCopy, 'utf8')) as { fields: unknown[] };
    partial.fields.pop();
    await writeFile(location.markerPath, `${JSON.stringify(partial)}\n`);
    const partialResult = await migrateCodexSessions({
      location,
      targets: [{ id, sourceProviderId: 'source-proxy', archived: false, storage: 'legacy', revision: '0'.repeat(64) }],
      targetProviderId: 'aio-proxy',
    });
    expect(partialResult.status).toBe('blocked');
    expect(JSON.stringify(partialResult)).not.toContain(root);
    expect(await readFile(rolloutPath, 'utf8')).toContain('source-proxy');
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
    const outcomes = await Promise.allSettled([acquireSessionLock(location), acquireSessionLock(location)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const lock = outcomes.find((outcome) => outcome.status === 'fulfilled')!;
    if (lock.status === 'fulfilled') {
      expect(lock.value.token).not.toBe('00000000-0000-4000-8000-000000000000');
      await lock.value.release();
    }
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

test('reclaims a lock directory left without an owner record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-ownerless-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await mkdir(join(location.managedRoot, 'migrations', '.lock'), { recursive: true });
    const lock = await acquireSessionLock(location);
    expect(lock.token).not.toBe('');
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not treat the current configure command as a Codex writer', () => {
  expect(isCodexWriterProcess(process.pid, '/usr/local/bin/aio-proxy agent configure codex')).toBe(false);
  expect(isCodexWriterProcess(process.pid + 1, '/usr/local/bin/aio-proxy agent configure codex')).toBe(false);
  expect(isCodexWriterProcess(process.pid + 1, '/usr/local/bin/codex')).toBe(true);
  expect(isCodexWriterProcess(process.pid + 1, '/usr/local/bin/codex-cli')).toBe(true);
  expect(isCodexWriterProcess(process.pid + 1, '/usr/local/bin/codex app-server')).toBe(true);
});

test('does not reclaim an expired lease held by a live process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-live-lease-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    const ownerPath = join(location.managedRoot, 'migrations', '.lock', 'owner.json');
    const owner = { pid: process.pid, token: '00000000-0000-4000-8000-000000000000', expiresAt: 1 };
    await mkdir(join(location.managedRoot, 'migrations', '.lock'), { recursive: true });
    await writeFile(ownerPath, JSON.stringify(owner));
    await expect(acquireSessionLock(location)).rejects.toThrow('another Codex session migration is in progress');
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual(owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reclaims an expired lease whose PID has been reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-reused-pid-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await mkdir(join(location.managedRoot, 'migrations', '.lock'), { recursive: true });
    await writeFile(
      join(location.managedRoot, 'migrations', '.lock', 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        starttime: 'previous-process-incarnation',
        token: '00000000-0000-4000-8000-000000000000',
        expiresAt: 1,
      }),
    );
    const lock = await acquireSessionLock(location);
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks restore when the journal file is replaced by a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-journal-link-'));
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
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
    const preview = await inspectCodexSessions(location);
    const migrated = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    const journalPath = join(location.managedRoot, 'migrations', migrated.operationId!, 'journal.json');
    const journalTarget = join(root, 'journal-copy.json');
    await writeFile(journalTarget, await readFile(journalPath));
    await rm(journalPath);
    await symlink(journalTarget, journalPath);
    const restored = await restoreCodexMigration(location, migrated.operationId!);
    expect(restored.status).toBe('blocked');
    expect(await readFile(rolloutPath, 'utf8')).toContain('aio-proxy');
    const currentDb = new Database(join(root, 'state_5.sqlite'));
    expect(currentDb.query('SELECT model_provider FROM threads WHERE id = ?').get(id)).toEqual({
      model_provider: 'aio-proxy',
    });
    currentDb.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates and restores a legacy session with a special provider ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-special-provider-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location);
    await mkdir(join(root, 'sessions'), { recursive: true });
    const rolloutPath = join(root, 'sessions', 'history.jsonl');
    await writeFile(rolloutPath, rollout('$&'));
    const db = new Database(join(root, 'state_5.sqlite'));
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    db.query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, '$&', 'legacy', 0, rolloutPath);
    db.close();
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
    const preview = await inspectCodexSessions(location);
    expect(preview.groups).toEqual([{ providerId: '$&', active: 1, archived: 0 }]);
    const migrated = await migrateCodexSessions({ location, targets: preview.targets, targetProviderId: 'aio-proxy' });
    expect(migrated.status).toBe('completed');
    expect(await readFile(rolloutPath, 'utf8')).toContain('"model_provider":"aio-proxy"');
    const restored = await restoreCodexMigration(location, migrated.operationId!);
    expect(restored.status).toBe('completed');
    expect(await readFile(rolloutPath, 'utf8')).toContain('"model_provider":"$&"');
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
    setSessionTestDeps({ offlineCheck: async () => 'codex_active' });
    const activeWriter = await restoreCodexMigration(location, migrated.operationId!);
    expect(activeWriter.status).toBe('blocked');
    setSessionTestDeps({ offlineCheck: async () => 'ok' });
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

test('blocks missing verified schema and rollout paths outside configured storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-session-schema-'));
  try {
    const location = resolveCodexLocation(root, { HOME: root, CODEX_SQLITE_HOME: root });
    await prepareMarker(location);
    const db = new Database(join(root, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT)');
    db.close();
    const drift = await inspectCodexSessions(location);
    expect(drift.blocked).toEqual([{ id: 'storage', reason: 'state database schema is not verified' }]);
    await rm(join(root, 'state_5.sqlite'));
    const rolloutPath = join(root, 'outside.jsonl');
    await writeFile(rolloutPath, rollout('source-proxy'));
    const next = new Database(join(root, 'state_5.sqlite'));
    next.exec(
      'CREATE TABLE threads (id TEXT, model_provider TEXT, history_mode TEXT, archived INTEGER, rollout_path TEXT)',
    );
    next
      .query('INSERT INTO threads VALUES (?, ?, ?, ?, ?)')
      .run(id, 'source-proxy', 'legacy', 0, '/outside/history.jsonl');
    next.close();
    const escaped = await inspectCodexSessions(location);
    expect(escaped.blocked).toContainEqual({ id, reason: 'index_rollout_mismatch' });
    expect(JSON.stringify(escaped)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

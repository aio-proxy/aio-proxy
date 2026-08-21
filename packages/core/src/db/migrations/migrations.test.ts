import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../index';
import { MIGRATIONS } from '../migrations.manifest';

function tableNames(sqlite: Database): string[] {
  return sqlite
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(({ name }) => name);
}

function expectCurrentPersistenceContract(sqlite: Database): void {
  const tables = tableNames(sqlite);
  const traceColumns = sqlite.query<{ name: string; type: string }, []>('PRAGMA table_info(trace_span)').all();
  const dailyColumns = sqlite.query<{ name: string; type: string }, []>('PRAGMA table_info(usage_daily)').all();

  expect(tables).not.toContain('request_log');
  expect(tables).not.toContain('usage');
  expect(tables).toEqual(expect.arrayContaining(['trace_span', 'usage_daily', 'session_affinity', 'session_response']));
  expect(traceColumns).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'estimated_cost_nano_usd', type: 'INTEGER' })]),
  );
  expect(traceColumns.some(({ name }) => name === 'estimated_cost_usd')).toBeFalse();
  expect(dailyColumns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'total_tokens', type: 'TEXT' }),
      expect.objectContaining({ name: 'estimated_cost_nano_usd', type: 'TEXT' }),
    ]),
  );
  expect(dailyColumns.some(({ name }) => name.includes('provider'))).toBeFalse();
}

test('runtime migrations match the committed Drizzle journal', () => {
  const journal = JSON.parse(readFileSync(join(import.meta.dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  expect(MIGRATIONS.map(({ file }) => file)).toEqual(journal.entries.map(({ tag }) => `${tag}.sql`));
  for (const migration of MIGRATIONS) {
    expect(createHash('sha256').update(migration.sql).digest('hex')).toBe(migration.sha256);
  }
});

test('applied migrations deploy the trace persistence contract', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-migrations-'));
  const handle = openDb({ home });
  try {
    expectCurrentPersistenceContract(handle.sqlite);
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('upgrading a version-two database removes legacy history and preserves trace persistence', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-migration-upgrade-'));
  const path = join(home, 'aio-proxy.db');
  const versionTwo = new Database(path);
  try {
    for (const migration of MIGRATIONS.slice(0, 2)) versionTwo.run(migration.sql);
    versionTwo.run('PRAGMA user_version = 2');
    versionTwo.run(
      "INSERT INTO trace_span (trace_id, span_id, name, kind, started_at, status_code, attributes_json, events_json, links_json) VALUES ('trace-1', 'span-1', 'aio_proxy.request', 1, 1, 0, '{}', '[]', '[]')",
    );
    versionTwo.run(
      "INSERT INTO usage_daily (local_day, model_dimension, request_count) VALUES ('2026-07-24', 'gpt-5', '1')",
    );
    versionTwo.run(
      "INSERT INTO session_affinity (session_source, session_id, requested_model_id, provider_id, revision, expires_at, updated_at) VALUES ('header', 'session-1', 'gpt-5', 'provider-1', 1, 2, 1)",
    );
    versionTwo.run(
      "INSERT INTO session_response (response_id_sha256, session_source, session_id, provider_id, expires_at) VALUES ('response-1', 'header', 'session-1', 'provider-1', 2)",
    );
    versionTwo.run(
      "INSERT INTO request_log (request_id, inbound_protocol, requested_model_id, outcome, attempts_json, started_at, completed_at, duration_ms) VALUES ('request-1', 'openai-compatible', 'gpt-5', 'success', '[]', 1, 2, 1)",
    );
    versionTwo.run(
      "INSERT INTO usage (id, request_id, provider_id, model_id, created_at) VALUES ('usage-1', 'request-1', 'provider-1', 'gpt-5', 2)",
    );
  } finally {
    versionTwo.close();
  }

  const handle = openDb({ home });
  try {
    expectCurrentPersistenceContract(handle.sqlite);
    expect(handle.sqlite.query('SELECT trace_id FROM trace_span').get()).toEqual({ trace_id: 'trace-1' });
    expect(handle.sqlite.query('SELECT request_count FROM usage_daily').get()).toEqual({ request_count: '1' });
    expect(
      handle.sqlite
        .query(
          'SELECT normalized_cache_read_tokens, normalized_prompt_tokens, cache_hit_rate_available FROM usage_daily',
        )
        .get(),
    ).toEqual({ normalized_cache_read_tokens: '0', normalized_prompt_tokens: '0', cache_hit_rate_available: 0 });
    expect(handle.sqlite.query('SELECT provider_id FROM session_affinity').get()).toEqual({
      provider_id: 'provider-1',
    });
    expect(handle.sqlite.query('SELECT provider_id FROM session_response').get()).toEqual({
      provider_id: 'provider-1',
    });
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('migration 6 preserves schema-5 session affinity data', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-migration-agent-'));
  const path = join(home, 'aio-proxy.db');
  const versionFive = new Database(path);
  try {
    for (const migration of MIGRATIONS.slice(0, 5)) versionFive.run(migration.sql);
    versionFive.run('PRAGMA user_version = 5');
    versionFive.run(`INSERT INTO session_affinity
      (session_source, session_id, requested_model_id, provider_id, revision, expires_at, updated_at)
      VALUES ('header', 'session-1', 'gpt-x', 'provider-a', 1, 999999, 1000)`);
  } finally {
    versionFive.close();
  }

  const handle = openDb({ home });
  try {
    expect(
      handle.sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_%' ORDER BY name")
        .all(),
    ).toHaveLength(4);
    expect(
      handle.sqlite.query("SELECT provider_id FROM session_affinity WHERE session_id = 'session-1'").get(),
    ).toEqual({
      provider_id: 'provider-a',
    });
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

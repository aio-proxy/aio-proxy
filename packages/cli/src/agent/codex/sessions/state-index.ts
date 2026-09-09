import { Database } from 'bun:sqlite';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { CodexLocation } from '../contracts';
import { assertNoSymlinkParents } from '../managed-config/storage';
import { inspectLegacyMetadata, fingerprintBytes } from './legacy-rollout';

export type IndexedSession = {
  readonly id: string;
  readonly sourceProviderId: string;
  readonly archived: boolean;
  readonly storage: 'legacy' | 'native';
  readonly revision: string;
  readonly rolloutPath: string;
  readonly dbPath?: string;
  readonly model?: string;
  readonly title?: string;
  readonly parentThreadId?: string;
  readonly createdAt?: number;
};

export type IndexBlocked = { readonly id: string; readonly reason: string };
export type StateSnapshot = { readonly sessions: readonly IndexedSession[]; readonly blocked: readonly IndexBlocked[] };

const databaseNames = ['state_5.sqlite', 'state.sqlite', 'state.db'] as const;
const roots = async (location: CodexLocation): Promise<string[]> => {
  const candidates = [location.sqliteHome, location.home].filter((value): value is string => value !== undefined);
  const result: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('configured storage root is unsafe');
      const canonical = await realpath(candidate);
      if (!result.includes(canonical)) result.push(canonical);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return result;
};

const contained = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

async function safeFile(path: string, allowedRoots: readonly string[]): Promise<string> {
  const absolute = isAbsolute(path) ? path : join(allowedRoots[0]!, path);
  await assertNoSymlinkParents(dirname(absolute));
  const canonical = await realpath(absolute);
  if (!allowedRoots.some((root) => contained(root, canonical)))
    throw new Error('rollout path escapes configured storage');
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('rollout path is not a regular file');
  return canonical;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  return typeof row[key] === 'string' ? row[key] : undefined;
}

async function findDatabase(allowedRoots: readonly string[]): Promise<string | undefined> {
  for (const root of allowedRoots) {
    for (const name of databaseNames) {
      const path = join(root, name);
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new Error('state database is a symbolic link');
        if (stat.isFile()) return path;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
  }
  return undefined;
}

function columns(database: Database, table: string): Set<string> {
  return new Set(
    (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

async function scanLegacy(allowedRoots: readonly string[]): Promise<StateSnapshot> {
  const sessions: IndexedSession[] = [];
  const blocked: IndexBlocked[] = [];
  async function visit(root: string, directory: string, archived: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        blocked.push({ id: entry.name, reason: 'symbolic_link_storage_entry' });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(root, path, archived);
        continue;
      }
      if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue;
      const bytes = new Uint8Array(await readFile(path));
      try {
        const meta = inspectLegacyMetadata(bytes);
        const canonical = await safeFile(path, [root]);
        sessions.push({
          id: meta.id,
          sourceProviderId: meta.providerId,
          archived,
          storage: 'legacy',
          revision: fingerprintBytes(bytes),
          rolloutPath: canonical,
        });
      } catch (error) {
        blocked.push({ id: entry.name, reason: error instanceof Error ? error.message : 'invalid_legacy_rollout' });
      }
    }
  }
  for (const root of allowedRoots) {
    await visit(root, join(root, 'sessions'), false);
    await visit(root, join(root, 'archived_sessions'), true);
  }
  return { sessions, blocked };
}

export async function readStateIndex(location: CodexLocation): Promise<StateSnapshot> {
  const allowedRoots = await roots(location);
  if (allowedRoots.length === 0)
    return { sessions: [], blocked: [{ id: 'storage', reason: 'configured_storage_missing' }] };
  const databasePath = await findDatabase(allowedRoots);
  if (databasePath === undefined) return scanLegacy(allowedRoots);
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const tables = new Set(
      (database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!tables.has('threads')) throw new Error('state database has no threads table');
    const fields = columns(database, 'threads');
    const required = ['id', 'model_provider', 'history_mode', 'archived', 'rollout_path'];
    const missing = required.filter((field) => !fields.has(field));
    if (missing.length > 0) throw new Error(`state database schema missing ${missing.join(', ')}`);
    const selected = [
      'id',
      'model_provider',
      'history_mode',
      'archived',
      'rollout_path',
      ...['model', 'title', 'parent_thread_id', 'created_at'].filter((field) => fields.has(field)),
    ];
    const rows = database.query(`SELECT ${selected.join(', ')} FROM threads`).all() as Array<Record<string, unknown>>;
    const sessions: IndexedSession[] = [];
    const blocked: IndexBlocked[] = [];
    for (const row of rows) {
      const id = optionalString(row, 'id') ?? 'unknown';
      const mode = optionalString(row, 'history_mode');
      const provider = optionalString(row, 'model_provider');
      const rollout = optionalString(row, 'rollout_path');
      if (provider === undefined || mode === undefined || rollout === undefined) {
        blocked.push({ id, reason: 'thread metadata is incomplete' });
        continue;
      }
      if (mode !== 'legacy' && mode !== 'paginated') {
        blocked.push({ id, reason: `history_mode ${mode} is not verified` });
        continue;
      }
      if (mode === 'paginated') {
        blocked.push({ id, reason: 'paginated history format is not verified for offline migration' });
        continue;
      }
      try {
        const path = await safeFile(rollout, allowedRoots);
        const bytes = new Uint8Array(await readFile(path));
        const metadata = inspectLegacyMetadata(bytes);
        if (metadata.id !== id) throw new Error('index rollout id does not match session_meta');
        if (metadata.providerId !== provider) throw new Error('index provider does not match rollout metadata');
        sessions.push({
          id,
          sourceProviderId: provider,
          archived: row['archived'] === 1 || row['archived'] === true,
          storage: 'legacy',
          revision: fingerprintBytes(bytes),
          rolloutPath: path,
          dbPath: databasePath,
          model: optionalString(row, 'model'),
          title: optionalString(row, 'title'),
          parentThreadId: optionalString(row, 'parent_thread_id'),
          createdAt: typeof row['created_at'] === 'number' ? row['created_at'] : undefined,
        });
      } catch (error) {
        blocked.push({ id, reason: error instanceof Error ? error.message : 'invalid rollout' });
      }
    }
    return { sessions, blocked };
  } finally {
    database.close();
  }
}

export async function resolveStateDatabase(location: CodexLocation): Promise<string | undefined> {
  const allowedRoots = await roots(location);
  return findDatabase(allowedRoots);
}

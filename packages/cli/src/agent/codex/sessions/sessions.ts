import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexLocation, MigrationPreview, MigrationResult, MigrationTarget, SessionGroup } from '../contracts';
import { inspectRegularFile } from '../managed-config/storage';
import {
  acquireSessionLock,
  createOperation,
  operationPath,
  readJournal,
  type JournalEntry,
  type SessionMigrationJournal,
  updateJournal,
  writeBackup,
} from './journal';
import { fingerprintBytes, inspectLegacyMetadata, rewriteLegacyProvider } from './legacy-rollout';
import { readStateIndex, type IndexedSession } from './state-index';

type SessionTestDeps = {
  readonly offlineCheck?: () => Promise<'ok' | 'codex_active' | 'offline_check_unavailable'>;
  readonly beforeLog?: () => Promise<void>;
  readonly afterFirstReplacement?: () => Promise<void>;
  readonly beforeCommit?: () => Promise<void>;
  readonly afterCommit?: () => Promise<void>;
  readonly randomUUID?: () => string;
};

let testDeps: SessionTestDeps = {};
export function setSessionTestDeps(deps: SessionTestDeps): void {
  testDeps = deps;
}

const defaultOfflineCheck = async (): Promise<'ok' | 'codex_active' | 'offline_check_unavailable'> => {
  try {
    const result = Bun.spawnSync(['ps', '-axo', 'command=']);
    if (result.exitCode !== 0) return 'offline_check_unavailable';
    const output = new TextDecoder().decode(result.stdout);
    return output.split('\n').some((line) => /(?:^|[\s/])codex(?:$|[\s/])/i.test(line)) ? 'codex_active' : 'ok';
  } catch {
    return 'offline_check_unavailable';
  }
};

const checkOffline = (): Promise<'ok' | 'codex_active' | 'offline_check_unavailable'> =>
  (testDeps.offlineCheck ?? defaultOfflineCheck)();

async function managedProvider(location: CodexLocation): Promise<string> {
  try {
    const marker = JSON.parse(await readFile(location.markerPath, 'utf8')) as { providerId?: unknown };
    if (typeof marker.providerId === 'string' && marker.providerId.length > 0) return marker.providerId;
  } catch {
    // An absent marker is expected before the first configure operation.
  }
  return 'aio-proxy';
}

export async function inspectCodexSessions(location: CodexLocation): Promise<MigrationPreview> {
  try {
    const snapshot = await readStateIndex(location);
    const grouped = new Map<string, SessionGroup>();
    for (const session of snapshot.sessions) {
      const previous = grouped.get(session.sourceProviderId) ?? {
        providerId: session.sourceProviderId,
        active: 0,
        archived: 0,
      };
      grouped.set(session.sourceProviderId, {
        providerId: previous.providerId,
        active: previous.active + (session.archived ? 0 : 1),
        archived: previous.archived + (session.archived ? 1 : 0),
      });
    }
    const targetProvider = await managedProvider(location);
    const targets = snapshot.sessions
      .filter((session) => session.sourceProviderId !== targetProvider)
      .map((session) => toTarget(session));
    return {
      groups: [...grouped.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
      targets,
      blocked: snapshot.blocked,
    };
  } catch (error) {
    return {
      groups: [],
      targets: [],
      blocked: [{ id: 'storage', reason: error instanceof Error ? error.message : 'Codex storage is unavailable' }],
    };
  }
}

function toTarget(session: IndexedSession): MigrationTarget {
  return {
    id: session.id,
    sourceProviderId: session.sourceProviderId,
    archived: session.archived,
    storage: session.storage,
    revision: session.revision,
  };
}

function resultBlocked(conflicts = 0): MigrationResult {
  return { status: 'blocked', migrated: 0, skipped: 0, conflicts: conflicts || 1 };
}

async function assertJournalPaths(location: CodexLocation, journal: SessionMigrationJournal): Promise<void> {
  const roots: string[] = [];
  for (const root of [location.home, location.sqliteHome]) {
    if (root === undefined) continue;
    try {
      roots.push(await realpath(root));
    } catch {
      throw new Error('configured storage root is unavailable');
    }
  }
  const operationRoot = await realpath(operationPath(location, journal.operationId));
  const managedRoot = await realpath(location.managedRoot);
  if (!(operationRoot === managedRoot || operationRoot.startsWith(`${managedRoot}/`)))
    throw new Error('migration journal escapes managed storage');
  const backupRoot = join(operationRoot, 'backups');
  const isUnder = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);
  for (const entry of journal.entries) {
    const fileStat = await lstat(entry.path);
    if (fileStat.isSymbolicLink() || !fileStat.isFile())
      throw new Error('migration journal contains unsafe rollout path');
    const canonical = await realpath(entry.path);
    if (!roots.some((root) => isUnder(root, canonical))) throw new Error('migration journal rollout escapes storage');
    const backupCanonical = await realpath(entry.backup);
    if (!isUnder(backupRoot, backupCanonical)) throw new Error('migration journal backup escapes operation');
  }
}

async function replaceFile(path: string, originalFingerprint: string, bytes: Uint8Array): Promise<void> {
  const stat = await inspectRegularFile(path);
  if (stat === undefined) throw new Error('rollout disappeared');
  const current = new Uint8Array(await readFile(path));
  if (fingerprintBytes(current) !== originalFingerprint) throw new Error('rollout changed during migration');
  const temporary = join(dirname(path), `.${path.split('/').at(-1)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const beforeRename = await lstat(path);
    if (beforeRename.isSymbolicLink() || !beforeRename.isFile()) throw new Error('rollout path became unsafe');
    if (fingerprintBytes(new Uint8Array(await readFile(path))) !== originalFingerprint)
      throw new Error('rollout changed before replacement');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreFiles(entries: readonly JournalEntry[], targetToSource: boolean): Promise<number> {
  let conflicts = 0;
  for (const entry of entries) {
    const bytes = new Uint8Array(await readFile(entry.path));
    const metadata = (() => {
      try {
        return inspectLegacyMetadata(bytes);
      } catch {
        return undefined;
      }
    })();
    if (metadata === undefined || metadata.id !== entry.id) {
      conflicts += 1;
      continue;
    }
    const from = targetToSource ? entry.targetProviderId : entry.sourceProviderId;
    const to = targetToSource ? entry.sourceProviderId : entry.targetProviderId;
    if (metadata.providerId === to) continue;
    if (metadata.providerId !== from) {
      conflicts += 1;
      continue;
    }
    const next = rewriteLegacyProvider(bytes, entry.id, from, to);
    await replaceFile(entry.path, fingerprintBytes(bytes), next);
  }
  return conflicts;
}

async function rollbackFiles(entries: readonly JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    try {
      const bytes = new Uint8Array(await readFile(entry.path));
      if (fingerprintBytes(bytes) !== entry.appliedFingerprint) continue;
      const backup = new Uint8Array(await readFile(entry.backup));
      await replaceFile(entry.path, entry.appliedFingerprint, backup);
    } catch {
      // Keep the journal as the durable recovery source if rollback cannot complete.
    }
  }
}

function updateDatabase(database: Database, targets: readonly MigrationTarget[], providerId: string): number {
  const update = database.query('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
  let changed = 0;
  for (const target of targets) {
    const result = update.run(providerId, target.id, target.sourceProviderId);
    if (result.changes !== 1) throw new Error('session_changed');
    changed += result.changes;
  }
  return changed;
}

export async function migrateCodexSessions(input: {
  readonly location: CodexLocation;
  readonly targets: readonly MigrationTarget[];
  readonly targetProviderId: string;
}): Promise<MigrationResult> {
  const { location, targets, targetProviderId } = input;
  if (targets.length === 0) return { status: 'completed', migrated: 0, skipped: 0, conflicts: 0 };
  const lockRelease = await acquireSessionLock(location);
  try {
    const offline = await checkOffline();
    if (offline !== 'ok') return resultBlocked();
    const preview = await inspectCodexSessions(location);
    if (preview.blocked.length > 0) return resultBlocked(preview.blocked.length);
    const snapshot = await readStateIndex(location);
    const byId = new Map<string, IndexedSession>(
      snapshot.sessions.map((session: IndexedSession) => [session.id, session]),
    );
    const selected: IndexedSession[] = [];
    let skipped = 0;
    let conflicts = 0;
    const seen = new Set<string>();
    for (const target of targets) {
      const session = byId.get(target.id);
      if (session === undefined || seen.has(target.id)) {
        skipped += 1;
        continue;
      }
      seen.add(target.id);
      if (target.storage !== 'legacy' || session.storage !== 'legacy' || target.revision !== session.revision) {
        conflicts += 1;
        continue;
      }
      if (session.sourceProviderId !== target.sourceProviderId || session.sourceProviderId === targetProviderId) {
        skipped += 1;
        continue;
      }
      selected.push(session);
    }
    const paths = new Set<string>();
    for (const session of selected) {
      if (paths.has(session.rolloutPath)) return resultBlocked(1);
      paths.add(session.rolloutPath);
    }
    if (selected.length === 0)
      return { status: conflicts > 0 ? 'partial' : 'completed', migrated: 0, skipped, conflicts };
    const operationId = testDeps.randomUUID?.() ?? crypto.randomUUID();
    const operationDir = operationPath(location, operationId);
    const entries: JournalEntry[] = [];
    const journalBase: SessionMigrationJournal = {
      format: 1,
      operationId,
      home: location.home,
      managedRoot: location.managedRoot,
      targetProviderId,
      status: 'prepared',
      entries,
      progress: 0,
      createdAt: Date.now(),
      databasePath: selected.find((session) => session.dbPath !== undefined)?.dbPath,
    };
    await createOperation(location, journalBase);
    try {
      if (testDeps.beforeLog !== undefined) await testDeps.beforeLog();
      for (const session of selected) {
        const original = new Uint8Array(await readFile(session.rolloutPath));
        if (fingerprintBytes(original) !== session.revision) throw new Error('rollout changed during preflight');
        const applied = rewriteLegacyProvider(original, session.id, session.sourceProviderId, targetProviderId);
        const backup = join(operationDir, 'backups', `${entries.length}.jsonl`);
        await writeBackup(backup, original);
        entries.push({
          id: session.id,
          sourceProviderId: session.sourceProviderId,
          targetProviderId,
          archived: session.archived,
          path: session.rolloutPath,
          backup,
          originalFingerprint: fingerprintBytes(original),
          appliedFingerprint: fingerprintBytes(applied),
          status: 'pending',
        });
      }
      await updateJournal(location, { ...journalBase, status: 'applying', entries });
      const databasePath = selected.find((session) => session.dbPath !== undefined)?.dbPath;
      const database = databasePath === undefined ? undefined : new Database(databasePath, { strict: true });
      let committed = false;
      try {
        database?.exec('BEGIN IMMEDIATE');
        if (database !== undefined)
          updateDatabase(
            database,
            targets.filter((target) => selected.some((s) => s.id === target.id)),
            targetProviderId,
          );
        for (let index = 0; index < selected.length; index += 1) {
          const entry = entries[index]!;
          const original = new Uint8Array(await readFile(entry.backup));
          const applied = rewriteLegacyProvider(original, entry.id, entry.sourceProviderId, targetProviderId);
          await replaceFile(entry.path, entry.originalFingerprint, applied);
          entries[index] = { ...entry, status: 'applied' };
          await updateJournal(location, { ...journalBase, status: 'applying', entries, progress: index + 1 });
          if (index === 0 && testDeps.afterFirstReplacement !== undefined) await testDeps.afterFirstReplacement();
        }
        if (testDeps.beforeCommit !== undefined) await testDeps.beforeCommit();
        database?.exec('COMMIT');
        committed = true;
        if (testDeps.afterCommit !== undefined) await testDeps.afterCommit();
        await updateJournal(location, { ...journalBase, status: 'completed', entries, progress: entries.length });
      } catch {
        if (!committed) database?.exec('ROLLBACK');
        if (database !== undefined) database.close();
        if (!committed) {
          await rollbackFiles(entries);
          await updateJournal(location, { ...journalBase, status: 'failed', entries });
          return {
            status: 'blocked',
            migrated: 0,
            skipped,
            conflicts: conflicts + 1,
            operationId,
            recoveryPath: operationDir,
          };
        }
        await updateJournal(location, { ...journalBase, status: 'committed', entries, progress: entries.length });
        return {
          status: 'partial',
          migrated: entries.length,
          skipped,
          conflicts: conflicts + 1,
          operationId,
          recoveryPath: operationDir,
        };
      }
      database?.close();
      return {
        status: conflicts > 0 || skipped > 0 ? 'partial' : 'completed',
        migrated: selected.length,
        skipped,
        conflicts,
        operationId,
        recoveryPath: operationDir,
      };
    } catch {
      await rollbackFiles(entries);
      await updateJournal(location, { ...journalBase, status: 'failed', entries });
      return {
        status: 'blocked',
        migrated: 0,
        skipped,
        conflicts: conflicts + 1,
        operationId,
        recoveryPath: operationDir,
      };
    }
  } finally {
    await lockRelease();
  }
}

export async function restoreCodexMigration(location: CodexLocation, operationId: string): Promise<MigrationResult> {
  const lockRelease = await acquireSessionLock(location);
  try {
    const journal = await readJournal(location, operationId);
    if (journal === undefined) return resultBlocked();
    await assertJournalPaths(location, journal);
    if (journal.status === 'restored')
      return { status: 'completed', migrated: 0, skipped: journal.entries.length, conflicts: 0, operationId };
    const database =
      journal.databasePath === undefined ? undefined : new Database(journal.databasePath, { strict: true });
    let conflicts = 0;
    try {
      database?.exec('BEGIN IMMEDIATE');
      if (database !== undefined) {
        const select = database.query<{ model_provider: string }, [string]>(
          'SELECT model_provider FROM threads WHERE id = ?',
        );
        const update = database.query('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
        for (const entry of journal.entries) {
          const current = select.get(entry.id);
          if (current === undefined) {
            conflicts += 1;
            continue;
          }
          if (current.model_provider === entry.sourceProviderId) continue;
          if (current.model_provider !== entry.targetProviderId) {
            conflicts += 1;
            continue;
          }
          const row = update.run(entry.sourceProviderId, entry.id, entry.targetProviderId);
          if (row.changes !== 1) conflicts += 1;
        }
      }
      conflicts += await restoreFiles(journal.entries, true);
      database?.exec('COMMIT');
      await updateJournal(location, {
        ...journal,
        status: 'restored',
        progress: journal.entries.length,
        entries: journal.entries.map((entry: JournalEntry) => ({ ...entry, status: 'restored' })),
      });
    } catch {
      database?.exec('ROLLBACK');
      await restoreFiles(journal.entries, false).catch(() => undefined);
      conflicts += 1;
      return {
        status: 'partial',
        migrated: 0,
        skipped: 0,
        conflicts,
        operationId,
        recoveryPath: operationPath(location, operationId),
      };
    } finally {
      database?.close();
    }
    return {
      status: conflicts > 0 ? 'partial' : 'completed',
      migrated: journal.entries.length - conflicts,
      skipped: 0,
      conflicts,
      operationId,
    };
  } finally {
    await lockRelease();
  }
}

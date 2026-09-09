import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexLocation, MigrationPreview, MigrationResult, MigrationTarget, SessionGroup } from '../contracts';
import { inspectRegularFile, syncParent } from '../managed-config/storage';
import {
  acquireSessionLock,
  createOperation,
  operationPath,
  type JournalEntry,
  type SessionMigrationJournal,
  updateJournal,
  writeBackup,
} from './journal';
import { fingerprintBytes, rewriteLegacyProvider } from './legacy-rollout';
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

const defaultOfflineCheck = async (
  location: CodexLocation,
): Promise<'ok' | 'codex_active' | 'offline_check_unavailable'> => {
  try {
    const result = Bun.spawnSync(['ps', '-axo', 'command=']);
    if (result.exitCode !== 0) return 'offline_check_unavailable';
    const output = new TextDecoder().decode(result.stdout);
    if (output.split('\n').some((line) => /(?:^|[\s/])codex(?:-cli)?(?:$|[\s/])|\bcodex\s+app-server\b/i.test(line)))
      return 'codex_active';
    const lsof = Bun.spawnSync(['lsof', '+D', location.home, '-n', '-P']);
    if (lsof.exitCode !== 127) {
      if (lsof.exitCode !== 0 && lsof.exitCode !== 1) return 'offline_check_unavailable';
      const handles = new TextDecoder().decode(lsof.stdout);
      if (handles.split('\n').some((line) => /codex(?:-cli)?|codex\s+app-server/i.test(line))) return 'codex_active';
      return 'ok';
    }
    const fuser = Bun.spawnSync(['fuser', '-m', location.home]);
    if (fuser.exitCode !== 127) {
      if (fuser.exitCode !== 0 && fuser.exitCode !== 1) return 'offline_check_unavailable';
      if (fuser.exitCode === 0 && /codex(?:-cli)?|codex\s+app-server/i.test(new TextDecoder().decode(fuser.stdout)))
        return 'codex_active';
    }
    const proc = await readdir('/proc', { withFileTypes: true }).catch(() => undefined);
    if (proc === undefined) return 'offline_check_unavailable';
    for (const entry of proc) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const command = await readFile(`/proc/${entry.name}/cmdline`).catch(() => undefined);
      if (command !== undefined && /codex(?:-cli)?|codex\s+app-server/i.test(command.toString('utf8')))
        return 'codex_active';
    }
    return 'ok';
  } catch {
    return 'offline_check_unavailable';
  }
};

const checkOffline = (location: CodexLocation): Promise<'ok' | 'codex_active' | 'offline_check_unavailable'> =>
  testDeps.offlineCheck !== undefined ? testDeps.offlineCheck() : defaultOfflineCheck(location);

async function managedProvider(location: CodexLocation): Promise<string> {
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(location.markerPath, 'utf8'));
  } catch {
    throw new Error('managed_marker_missing_or_invalid');
  }
  if (typeof marker !== 'object' || marker === null) throw new Error('managed_marker_invalid');
  const value = marker as { format?: unknown; managedBy?: unknown; configPath?: unknown; providerId?: unknown };
  if (
    value.format !== 1 ||
    value.managedBy !== 'aio-proxy' ||
    value.configPath !== location.configPath ||
    typeof value.providerId !== 'string' ||
    value.providerId.length === 0
  )
    throw new Error('managed_marker_invalid');
  let config: unknown;
  try {
    config = Bun.TOML.parse(await readFile(location.configPath, 'utf8'));
  } catch {
    throw new Error('managed_config_missing_or_invalid');
  }
  if (
    typeof config !== 'object' ||
    config === null ||
    (config as { model_provider?: unknown }).model_provider !== value.providerId
  )
    throw new Error('managed_config_invalid');
  return value.providerId;
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
      blocked: [{ id: 'storage', reason: previewDiagnostic(error) }],
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

const recoveryPathFor = (operationId: string): string => `migrations/${operationId}`;
const previewDiagnostic = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  if (/^(managed_marker|managed_config)_/.test(message)) return message;
  if (message.includes('paginated')) return 'paginated history format is not verified for offline migration';
  if (message.includes('schema')) return 'state database schema is not verified';
  return 'storage_blocked';
};

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
    await syncParent(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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

function selectMigrationSessions(
  snapshot: { readonly sessions: readonly IndexedSession[] },
  targets: readonly MigrationTarget[],
  targetProviderId: string,
): { readonly selected: readonly IndexedSession[]; readonly skipped: number; readonly conflicts: number } {
  const byId = new Map(snapshot.sessions.map((session) => [session.id, session]));
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
  return { selected, skipped, conflicts };
}

export async function migrateCodexSessions(input: {
  readonly location: CodexLocation;
  readonly targets: readonly MigrationTarget[];
  readonly targetProviderId: string;
}): Promise<MigrationResult> {
  const { location, targets, targetProviderId } = input;
  if (targets.length === 0) return { status: 'completed', migrated: 0, skipped: 0, conflicts: 0 };
  const lock = await acquireSessionLock(location);
  try {
    await lock.renew();
    const offline = await checkOffline(location);
    if (offline !== 'ok') return resultBlocked();
    const preview = await inspectCodexSessions(location);
    if (preview.blocked.length > 0) return resultBlocked(preview.blocked.length);
    if (targetProviderId !== (await managedProvider(location))) return resultBlocked();
    const snapshot = await readStateIndex(location);
    const { selected, skipped, conflicts } = selectMigrationSessions(snapshot, targets, targetProviderId);
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
      ownerToken: lock.token,
    };
    let transactionCommitted = false;
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
          await lock.renew();
          if (index === 0 && testDeps.afterFirstReplacement !== undefined) await testDeps.afterFirstReplacement();
        }
        if (testDeps.beforeCommit !== undefined) await testDeps.beforeCommit();
        database?.exec('COMMIT');
        committed = true;
        transactionCommitted = true;
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
            recoveryPath: recoveryPathFor(operationId),
          };
        }
        await updateJournal(location, { ...journalBase, status: 'committed', entries, progress: entries.length }).catch(
          () => undefined,
        );
        return {
          status: 'partial',
          migrated: entries.length,
          skipped,
          conflicts: conflicts + 1,
          operationId,
          recoveryPath: recoveryPathFor(operationId),
        };
      }
      database?.close();
      return {
        status: conflicts > 0 || skipped > 0 ? 'partial' : 'completed',
        migrated: selected.length,
        skipped,
        conflicts,
        operationId,
        recoveryPath: recoveryPathFor(operationId),
      };
    } catch {
      if (transactionCommitted) {
        await updateJournal(location, { ...journalBase, status: 'committed', entries, progress: entries.length }).catch(
          () => undefined,
        );
        return {
          status: 'partial',
          migrated: entries.length,
          skipped,
          conflicts: conflicts + 1,
          operationId,
          recoveryPath: recoveryPathFor(operationId),
        };
      }
      await rollbackFiles(entries);
      await updateJournal(location, { ...journalBase, status: 'failed', entries }).catch(() => undefined);
      return {
        status: 'blocked',
        migrated: 0,
        skipped,
        conflicts: conflicts + 1,
        operationId,
        recoveryPath: recoveryPathFor(operationId),
      };
    }
  } finally {
    await lock.release();
  }
}

import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { CodexLocation, MigrationResult } from '../contracts';
import { assertNoSymlinkParents, inspectRegularFile, syncParent } from '../managed-config/storage';
import {
  acquireSessionLock,
  operationPath,
  readJournal,
  type JournalEntry,
  type SessionMigrationJournal,
  updateJournal,
} from './journal';
import { fingerprintBytes, inspectLegacyMetadata, rewriteLegacyProvider } from './legacy-rollout';
import { checkCodexOffline } from './sessions';

const blocked = (): MigrationResult => ({ status: 'blocked', migrated: 0, skipped: 0, conflicts: 1 });
const recoveryPathFor = (operationId: string): string => `migrations/${operationId}`;
const isUnder = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

async function assertJournalPaths(location: CodexLocation, journal: SessionMigrationJournal): Promise<void> {
  if (journal.home !== location.home || journal.managedRoot !== location.managedRoot)
    throw new Error('migration journal location mismatch');
  const roots: string[] = [];
  for (const root of [location.home, location.sqliteHome]) {
    if (root === undefined) continue;
    try {
      roots.push(await realpath(root));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const operationPathValue = operationPath(location, journal.operationId);
  await assertNoSymlinkParents(dirname(operationPathValue));
  const operationStat = await lstat(operationPathValue);
  if (operationStat.isSymbolicLink() || !operationStat.isDirectory()) throw new Error('migration operation is unsafe');
  const operationRoot = await realpath(operationPathValue);
  const managedRoot = await realpath(location.managedRoot);
  if (!isUnder(managedRoot, operationRoot)) throw new Error('migration journal escapes managed storage');
  const backupDirectory = join(operationPathValue, 'backups');
  await assertNoSymlinkParents(backupDirectory);
  const backupDirectoryStat = await lstat(backupDirectory);
  if (backupDirectoryStat.isSymbolicLink() || !backupDirectoryStat.isDirectory())
    throw new Error('migration backup is unsafe');
  for (const entry of journal.entries) {
    await assertNoSymlinkParents(dirname(entry.path));
    await assertNoSymlinkParents(dirname(entry.backup));
    const fileStat = await lstat(entry.path);
    if (fileStat.isSymbolicLink() || !fileStat.isFile())
      throw new Error('migration journal contains unsafe rollout path');
    const backupStat = await lstat(entry.backup);
    if (backupStat.isSymbolicLink() || !backupStat.isFile())
      throw new Error('migration journal contains unsafe backup');
    const canonical = await realpath(entry.path);
    const backup = await realpath(entry.backup);
    if (!roots.some((root) => isUnder(root, canonical))) throw new Error('migration journal rollout escapes storage');
    if (!isUnder(join(operationRoot, 'backups'), backup)) throw new Error('migration journal backup escapes operation');
  }
  if (journal.databasePath !== undefined) {
    if (location.sqliteHome === undefined) throw new Error('migration journal database root is not configured');
    await assertNoSymlinkParents(dirname(journal.databasePath));
    const dbStat = await lstat(journal.databasePath);
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) throw new Error('migration journal database is unsafe');
    const databasePath = await realpath(journal.databasePath);
    if (!isUnder(await realpath(location.sqliteHome), databasePath) || basename(databasePath) !== 'state_5.sqlite')
      throw new Error('migration journal database is not the verified state index');
  }
}

async function replaceFile(path: string, originalFingerprint: string, bytes: Uint8Array): Promise<void> {
  if ((await inspectRegularFile(path)) === undefined) throw new Error('rollout disappeared');
  if (fingerprintBytes(await Bun.file(path).bytes()) !== originalFingerprint) throw new Error('rollout changed');
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
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe rollout path');
    if (fingerprintBytes(await Bun.file(path).bytes()) !== originalFingerprint) throw new Error('rollout changed');
    await rename(temporary, path);
    await syncParent(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

type RestoreFilePlan = { readonly entry: JournalEntry; readonly current: Uint8Array; readonly next?: Uint8Array };
async function planFiles(entries: readonly JournalEntry[]): Promise<{ plans: RestoreFilePlan[]; conflicts: number }> {
  const plans: RestoreFilePlan[] = [];
  let conflicts = 0;
  for (const entry of entries) {
    const backup = await Bun.file(entry.backup).bytes();
    try {
      const metadata = inspectLegacyMetadata(backup);
      if (
        fingerprintBytes(backup) !== entry.originalFingerprint ||
        metadata.id !== entry.id ||
        metadata.providerId !== entry.sourceProviderId
      ) {
        conflicts += 1;
        continue;
      }
    } catch {
      conflicts += 1;
      continue;
    }
    const current = await Bun.file(entry.path).bytes();
    let metadata;
    try {
      metadata = inspectLegacyMetadata(current);
    } catch {
      metadata = undefined;
    }
    if (metadata === undefined || metadata.id !== entry.id) {
      conflicts += 1;
      continue;
    }
    if (metadata.providerId === entry.sourceProviderId) plans.push({ entry, current });
    else if (metadata.providerId === entry.targetProviderId)
      plans.push({
        entry,
        current,
        next: rewriteLegacyProvider(current, entry.id, entry.targetProviderId, entry.sourceProviderId),
      });
    else conflicts += 1;
  }
  return { plans, conflicts };
}

async function applyFiles(plans: readonly RestoreFilePlan[]): Promise<void> {
  for (const plan of plans)
    if (plan.next !== undefined) await replaceFile(plan.entry.path, fingerprintBytes(plan.current), plan.next);
}
async function rollbackFiles(plans: readonly RestoreFilePlan[]): Promise<void> {
  for (const plan of plans) {
    if (plan.next === undefined) continue;
    await replaceFile(plan.entry.path, fingerprintBytes(plan.next), plan.current).catch(() => undefined);
  }
}

export async function restoreCodexMigration(location: CodexLocation, operationId: string): Promise<MigrationResult> {
  const lock = await acquireSessionLock(location);
  try {
    if ((await checkCodexOffline(location)) !== 'ok') return blocked();
    let journal: SessionMigrationJournal | undefined;
    try {
      journal = await readJournal(location, operationId);
    } catch {
      return blocked();
    }
    if (journal === undefined) return blocked();
    try {
      await assertJournalPaths(location, journal);
    } catch {
      return blocked();
    }
    if (journal.status === 'restored')
      return { status: 'completed', migrated: 0, skipped: journal.entries.length, conflicts: 0, operationId };
    let filePlan: { plans: RestoreFilePlan[]; conflicts: number };
    try {
      filePlan = await planFiles(journal.entries);
    } catch {
      return blocked();
    }
    let conflicts = filePlan.conflicts;
    const dbActions = new Set<string>();
    if (journal.databasePath !== undefined) {
      try {
        const db = new Database(journal.databasePath, { readonly: true, strict: true });
        try {
          const select = db.query<{ model_provider: string }, [string]>(
            'SELECT model_provider FROM threads WHERE id = ?',
          );
          for (const entry of journal.entries) {
            const current = select.get(entry.id);
            if (current == null) conflicts += 1;
            else if (current.model_provider === entry.targetProviderId) dbActions.add(entry.id);
            else if (current.model_provider !== entry.sourceProviderId) conflicts += 1;
          }
        } finally {
          db.close();
        }
      } catch {
        return blocked();
      }
    }
    if (conflicts > 0)
      return {
        status: 'partial',
        migrated: 0,
        skipped: 0,
        conflicts,
        operationId,
        recoveryPath: recoveryPathFor(operationId),
      };
    let db: Database | undefined;
    try {
      db = journal.databasePath === undefined ? undefined : new Database(journal.databasePath, { strict: true });
    } catch {
      return blocked();
    }
    let committed = false;
    try {
      db?.exec('BEGIN IMMEDIATE');
      if (db !== undefined) {
        const update = db.query('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
        for (const entry of journal.entries)
          if (
            dbActions.has(entry.id) &&
            update.run(entry.sourceProviderId, entry.id, entry.targetProviderId).changes !== 1
          )
            throw new Error('session_changed');
      }
      await applyFiles(filePlan.plans);
      await lock.renew();
      db?.exec('COMMIT');
      committed = true;
      await updateJournal(location, {
        ...journal,
        status: 'restored',
        progress: journal.entries.length,
        entries: journal.entries.map((entry) => ({ ...entry, status: 'restored' })),
      });
    } catch {
      if (!committed) {
        db?.exec('ROLLBACK');
        await rollbackFiles(filePlan.plans);
      } else
        await updateJournal(location, { ...journal, status: 'committed', progress: journal.entries.length }).catch(
          () => undefined,
        );
      conflicts += 1;
      return {
        status: 'partial',
        migrated: 0,
        skipped: 0,
        conflicts,
        operationId,
        recoveryPath: recoveryPathFor(operationId),
      };
    } finally {
      db?.close();
    }
    return { status: 'completed', migrated: journal.entries.length - conflicts, skipped: 0, conflicts, operationId };
  } finally {
    await lock.release();
  }
}

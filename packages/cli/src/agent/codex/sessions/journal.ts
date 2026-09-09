import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { CodexLocation } from '../contracts';
import { assertNoSymlinkParents, durableWrite, isFsCode } from '../managed-config/storage';

export type JournalEntry = {
  readonly id: string;
  readonly sourceProviderId: string;
  readonly targetProviderId: string;
  readonly archived: boolean;
  readonly path: string;
  readonly backup: string;
  readonly originalFingerprint: string;
  readonly appliedFingerprint: string;
  readonly status: 'pending' | 'applied' | 'restored';
};

export type SessionMigrationJournal = {
  readonly format: 1;
  readonly operationId: string;
  readonly home: string;
  readonly managedRoot: string;
  readonly targetProviderId: string;
  readonly status: 'prepared' | 'applying' | 'committed' | 'completed' | 'restored' | 'failed';
  readonly entries: readonly JournalEntry[];
  readonly progress: number;
  readonly createdAt: number;
  readonly databasePath?: string;
};

const migrationRoot = (location: CodexLocation): string => join(location.managedRoot, 'migrations');
export const operationPath = (location: CodexLocation, operationId: string): string =>
  join(migrationRoot(location), operationId);
const journalPath = (location: CodexLocation, operationId: string): string =>
  join(operationPath(location, operationId), 'journal.json');
const lockPath = (location: CodexLocation): string => join(migrationRoot(location), '.lock');

export async function acquireSessionLock(location: CodexLocation): Promise<() => Promise<void>> {
  await assertNoSymlinkParents(migrationRoot(location));
  await mkdir(migrationRoot(location), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath(location), { recursive: false, mode: 0o700 });
  } catch (error) {
    if (isFsCode(error, 'EEXIST')) throw new Error('another Codex session migration is in progress');
    throw error;
  }
  return async () => rm(lockPath(location), { recursive: true, force: true });
}

export async function createOperation(location: CodexLocation, journal: SessionMigrationJournal): Promise<void> {
  await assertNoSymlinkParents(operationPath(location, journal.operationId));
  await mkdir(join(operationPath(location, journal.operationId), 'backups'), { recursive: true, mode: 0o700 });
  await writeJournal(location, journal);
}

export async function writeBackup(path: string, bytes: Uint8Array): Promise<void> {
  const { writeFile, open } = await import('node:fs/promises');
  await assertNoSymlinkParents(path);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJournal(
  location: CodexLocation,
  operationId: string,
): Promise<SessionMigrationJournal | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))
    throw new Error('invalid migration operation id');
  try {
    const text = await readFile(journalPath(location, operationId), 'utf8');
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as { format?: unknown }).format !== 1 ||
      (value as { operationId?: unknown }).operationId !== operationId ||
      !Array.isArray((value as { entries?: unknown }).entries)
    )
      throw new Error('unsupported migration journal');
    return value as SessionMigrationJournal;
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function writeJournal(location: CodexLocation, journal: SessionMigrationJournal): Promise<void> {
  await durableWrite(journalPath(location, journal.operationId), `${JSON.stringify(journal)}\n`, 0o600);
}

export async function updateJournal(location: CodexLocation, journal: SessionMigrationJournal): Promise<void> {
  const path = journalPath(location, journal.operationId);
  const current = await readFile(path, 'utf8');
  await durableWrite(path, `${JSON.stringify(journal)}\n`, 0o600, {
    text: current,
    stat: await lstat(path),
  });
}

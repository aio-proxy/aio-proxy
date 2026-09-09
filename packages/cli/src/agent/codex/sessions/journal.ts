import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodexLocation } from '../contracts';
import { assertNoSymlinkParents, durableWrite, isFsCode, readRegularFile, syncParent } from '../managed-config/storage';

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
  readonly ownerToken: string;
};

type LeaseOwner = { readonly pid: number; readonly token: string; readonly expiresAt: number };
export type SessionLock = {
  readonly token: string;
  readonly renew: () => Promise<void>;
  readonly release: () => Promise<void>;
};
const leaseDurationMs = 10 * 60 * 1000;

const migrationRoot = (location: CodexLocation): string => join(location.managedRoot, 'migrations');
export const operationPath = (location: CodexLocation, operationId: string): string =>
  join(migrationRoot(location), operationId);
const journalPath = (location: CodexLocation, operationId: string): string =>
  join(operationPath(location, operationId), 'journal.json');
const lockPath = (location: CodexLocation): string => join(migrationRoot(location), '.lock');
const ownerPath = (location: CodexLocation): string => join(lockPath(location), 'owner.json');
const quarantinePath = (location: CodexLocation, token: string): string =>
  join(migrationRoot(location), `.lock-reclaim-${token}`);

const validToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const parseOwner = (value: unknown): LeaseOwner | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const owner = value as Partial<LeaseOwner>;
  return typeof owner.pid === 'number' &&
    Number.isInteger(owner.pid) &&
    validToken(owner.token) &&
    typeof owner.expiresAt === 'number' &&
    Number.isFinite(owner.expiresAt)
    ? { pid: owner.pid, token: owner.token, expiresAt: owner.expiresAt }
    : undefined;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/i;
const validEntry = (value: unknown): value is JournalEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<JournalEntry>;
  return (
    typeof entry.id === 'string' &&
    uuid.test(entry.id) &&
    typeof entry.sourceProviderId === 'string' &&
    entry.sourceProviderId.length > 0 &&
    typeof entry.targetProviderId === 'string' &&
    entry.targetProviderId.length > 0 &&
    typeof entry.archived === 'boolean' &&
    typeof entry.path === 'string' &&
    entry.path.length > 0 &&
    typeof entry.backup === 'string' &&
    entry.backup.length > 0 &&
    typeof entry.originalFingerprint === 'string' &&
    sha256.test(entry.originalFingerprint) &&
    typeof entry.appliedFingerprint === 'string' &&
    sha256.test(entry.appliedFingerprint) &&
    (entry.status === 'pending' || entry.status === 'applied' || entry.status === 'restored')
  );
};

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code !== 'ESRCH';
  }
}

async function readLease(location: CodexLocation): Promise<LeaseOwner | undefined> {
  try {
    return parseOwner(JSON.parse(await readFile(ownerPath(location), 'utf8')));
  } catch {
    return undefined;
  }
}

async function writeLease(location: CodexLocation, owner: LeaseOwner): Promise<void> {
  await durableWrite(ownerPath(location), `${JSON.stringify(owner)}\n`, 0o600);
  await syncParent(ownerPath(location));
}

async function reclaimExpiredLock(
  location: CodexLocation,
  observed: LeaseOwner,
  contenderToken: string,
): Promise<boolean> {
  const quarantine = quarantinePath(location, contenderToken);
  try {
    await rename(lockPath(location), quarantine);
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return false;
    throw error;
  }
  let owner: LeaseOwner | undefined;
  try {
    owner = parseOwner(JSON.parse(await readFile(join(quarantine, 'owner.json'), 'utf8')));
  } catch {
    await restoreQuarantinedLock(location, quarantine);
    return false;
  }
  if (
    owner === undefined ||
    owner.token !== observed.token ||
    owner.pid !== observed.pid ||
    owner.expiresAt !== observed.expiresAt ||
    owner.expiresAt > Date.now() ||
    processAlive(owner.pid)
  ) {
    await restoreQuarantinedLock(location, quarantine);
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  await syncParent(quarantine);
  return true;
}

async function restoreQuarantinedLock(location: CodexLocation, quarantine: string): Promise<void> {
  try {
    await rename(quarantine, lockPath(location));
    await syncParent(lockPath(location));
  } catch (error) {
    if (isFsCode(error, 'EEXIST')) {
      await rm(quarantine, { recursive: true, force: true });
      await syncParent(quarantine);
      return;
    }
    if (!isFsCode(error, 'ENOENT')) throw error;
  }
}

export async function acquireSessionLock(location: CodexLocation): Promise<SessionLock> {
  await assertNoSymlinkParents(migrationRoot(location));
  await mkdir(migrationRoot(location), { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const owner: LeaseOwner = { pid: process.pid, token, expiresAt: Date.now() + leaseDurationMs };
  for (;;) {
    try {
      await mkdir(lockPath(location), { recursive: false, mode: 0o700 });
      await writeLease(location, owner);
      await syncParent(lockPath(location));
      break;
    } catch (error) {
      if (!isFsCode(error, 'EEXIST')) throw error;
      const current = await readLease(location);
      if (current === undefined || processAlive(current.pid) || current.expiresAt > Date.now())
        throw new Error('another Codex session migration is in progress');
      await reclaimExpiredLock(location, current, token);
    }
  }
  const renew = async (): Promise<void> => {
    const current = await readLease(location);
    if (current?.token !== token) throw new Error('migration lease was lost');
    const snapshot = await readRegularFile(ownerPath(location));
    if (snapshot === undefined) throw new Error('migration lease disappeared');
    await durableWrite(
      ownerPath(location),
      `${JSON.stringify({ ...current, expiresAt: Date.now() + leaseDurationMs })}\n`,
      0o600,
      snapshot,
    );
    await syncParent(ownerPath(location));
  };
  const release = async (): Promise<void> => {
    const current = await readLease(location);
    if (current?.token !== token) return;
    await rm(lockPath(location), { recursive: true, force: true });
    await syncParent(lockPath(location));
  };
  return { token, renew, release };
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
    const path = journalPath(location, operationId);
    await assertNoSymlinkParents(dirname(path));
    const snapshot = await readRegularFile(path);
    if (snapshot === undefined) return undefined;
    const text = snapshot.text;
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as { format?: unknown }).format !== 1 ||
      (value as { operationId?: unknown }).operationId !== operationId ||
      !Array.isArray((value as { entries?: unknown }).entries) ||
      typeof (value as { home?: unknown }).home !== 'string' ||
      typeof (value as { managedRoot?: unknown }).managedRoot !== 'string' ||
      typeof (value as { targetProviderId?: unknown }).targetProviderId !== 'string' ||
      !validToken((value as { ownerToken?: unknown }).ownerToken) ||
      !Number.isInteger((value as { progress?: unknown }).progress) ||
      !Number.isFinite((value as { createdAt?: unknown }).createdAt) ||
      !['prepared', 'applying', 'committed', 'completed', 'restored', 'failed'].includes(
        (value as { status?: unknown }).status as string,
      ) ||
      ((value as { databasePath?: unknown }).databasePath !== undefined &&
        typeof (value as { databasePath?: unknown }).databasePath !== 'string')
    )
      throw new Error('unsupported migration journal');
    const journal = value as SessionMigrationJournal;
    if (journal.entries.some((entry) => !validEntry(entry))) throw new Error('invalid migration journal entry');
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const entry of journal.entries) {
      if (ids.has(entry.id) || paths.has(entry.path)) throw new Error('duplicate migration journal entry');
      if (entry.targetProviderId !== journal.targetProviderId) throw new Error('journal target provider mismatch');
      ids.add(entry.id);
      paths.add(entry.path);
    }
    if (journal.progress < 0 || journal.progress > journal.entries.length)
      throw new Error('invalid migration progress');
    return journal;
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function writeJournal(location: CodexLocation, journal: SessionMigrationJournal): Promise<void> {
  const path = journalPath(location, journal.operationId);
  await assertNoSymlinkParents(dirname(path));
  await durableWrite(path, `${JSON.stringify(journal)}\n`, 0o600);
}

export async function updateJournal(location: CodexLocation, journal: SessionMigrationJournal): Promise<void> {
  const path = journalPath(location, journal.operationId);
  await assertNoSymlinkParents(dirname(path));
  const snapshot = await readRegularFile(path);
  if (snapshot === undefined) throw new Error('migration journal disappeared');
  await durableWrite(path, `${JSON.stringify(journal)}\n`, 0o600, {
    text: snapshot.text,
    stat: snapshot.stat,
  });
}

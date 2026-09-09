import { open, readFile, lstat } from 'node:fs/promises';

import type { CodexLocation, CodexMarker } from '../contracts';
import {
  durableDelete,
  durableWrite,
  ensureManagedRoot,
  fingerprint,
  isFsCode,
  readRegularFile,
  syncParent,
} from './storage';

export type ConfigJournal = {
  readonly operation: 'configure' | 'remove';
  readonly originalExists: boolean;
  readonly beforeFingerprint?: string;
  readonly afterFingerprint?: string;
  readonly oldMarker?: CodexMarker;
  readonly targetMarker?: CodexMarker;
  readonly stage: 'prepared' | 'config-written' | 'marker-written';
  readonly owner?: { readonly pid: number; readonly token: string; readonly leaseUntil: number };
};

const pathFor = (location: CodexLocation): string => `${location.managedRoot}/config-operation.json`;

export async function readJournal(location: CodexLocation): Promise<ConfigJournal | undefined> {
  try {
    const stat = await lstat(pathFor(location));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Codex operation journal is invalid');
    return JSON.parse(await readFile(pathFor(location), 'utf8')) as ConfigJournal;
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function startJournal(location: CodexLocation, journal: ConfigJournal): Promise<ConfigJournal> {
  await ensureManagedRoot(location);
  const path = pathFor(location);
  const owner = { pid: process.pid, token: crypto.randomUUID(), leaseUntil: Date.now() + 30_000 };
  const record = { ...journal, owner };
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncParent(path);
  activeOwners.set(owner.token, owner);
  return record;
}

export async function updateJournal(location: CodexLocation, journal: ConfigJournal): Promise<void> {
  const current = await readRegularFile(pathFor(location));
  if (current === undefined) throw new Error('Codex operation journal disappeared');
  await durableWrite(pathFor(location), `${JSON.stringify(journal)}\n`, 0o600, current);
}

export async function clearJournal(location: CodexLocation): Promise<void> {
  const path = pathFor(location);
  const current = await readJournal(location);
  const file = await readRegularFile(path);
  await durableDelete(path, file);
  if (current?.owner !== undefined) activeOwners.delete(current.owner.token);
}

export const journalPath = pathFor;

const activeOwners = new Map<string, { readonly pid: number; readonly token: string; readonly leaseUntil: number }>();

export function isLiveJournal(journal: ConfigJournal | undefined): boolean {
  const owner = journal?.owner;
  if (owner === undefined || !Number.isInteger(owner.pid) || typeof owner.token !== 'string') return true;
  if (activeOwners.has(owner.token)) return true;
  if (owner.pid === process.pid) return owner.leaseUntil > Date.now();
  if (owner.leaseUntil <= Date.now()) {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return !isFsCode(error, 'ESRCH');
    }
  }
  return true;
}

export { fingerprint };

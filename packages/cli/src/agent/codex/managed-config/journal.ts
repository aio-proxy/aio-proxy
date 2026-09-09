import { open, rm, readFile, lstat } from 'node:fs/promises';

import type { CodexLocation, CodexMarker } from '../contracts';
import { durableWrite, ensureManagedRoot, fingerprint, isFsCode } from './storage';

export type ConfigJournal = {
  readonly operation: 'configure' | 'remove';
  readonly originalExists: boolean;
  readonly beforeFingerprint?: string;
  readonly afterFingerprint?: string;
  readonly oldMarker?: CodexMarker;
  readonly targetMarker?: CodexMarker;
  readonly stage: 'prepared' | 'config-written' | 'marker-written';
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

export async function startJournal(location: CodexLocation, journal: ConfigJournal): Promise<void> {
  await ensureManagedRoot(location);
  const path = pathFor(location);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function updateJournal(location: CodexLocation, journal: ConfigJournal): Promise<void> {
  await durableWrite(pathFor(location), `${JSON.stringify(journal)}\n`, 0o600);
}

export async function clearJournal(location: CodexLocation): Promise<void> {
  await rm(pathFor(location), { force: true });
}

export const journalPath = pathFor;

export { fingerprint };

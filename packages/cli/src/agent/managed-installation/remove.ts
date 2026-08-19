import type { Dirent } from 'node:fs';
import { chmod, lstat, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentLocation } from '../hosts';
import { inspectPath, writeDurable } from './durable';
import { inspectManagedInstallation, openCodeEntry } from './inspect';

export type ManagedRemoveTestDeps = {
  readonly failpoint?: (point: 'content_removed') => void | Promise<void>;
};

const MARKER_NAME = '.aio-proxy-managed.json';

const removeEntry = async (path: string, entry: Dirent): Promise<void> => {
  if (entry.isSymbolicLink() || entry.isFile()) {
    await unlink(path);
    return;
  }
  if (entry.isDirectory()) {
    const children = await readdir(path, { withFileTypes: true });
    for (const child of children) await removeEntry(join(path, child.name), child);
    await rmdir(path);
    return;
  }
  await unlink(path);
};

const removeChildrenExceptMarker = async (directory: string): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === MARKER_NAME) continue;
    await removeEntry(join(directory, entry.name), entry);
  }
};

const unlinkValidatedEntry = async (path: string, installationId: string): Promise<void> => {
  const stat = await inspectPath(path);
  if (stat === undefined) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('entry conflict');
  if (!(await readFile(path)).equals(Buffer.from(openCodeEntry(installationId)))) {
    throw new Error('entry conflict');
  }
  const again = await lstat(path);
  if (again.isSymbolicLink() || !again.isFile()) throw new Error('entry conflict');
  await unlink(path);
};

export async function removeManagedIntegration(
  location: AgentLocation,
  expectedInstallationId: string,
  testDeps?: ManagedRemoveTestDeps,
): Promise<void> {
  const status = await inspectManagedInstallation(location, Date.now);
  if (status.integration === 'conflict') {
    throw new Error(status.reason === 'entry_invalid' ? 'entry conflict' : `managed ${status.reason ?? 'conflict'}`);
  }
  if (status.integration !== 'managed' || status.marker.installationId !== expectedInstallationId) {
    throw new Error('managed installation is required');
  }

  const markerPath = join(location.managedDir, MARKER_NAME);
  const markerStat = await lstat(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) throw new Error('managed marker invalid');
  const markerBytes = await readFile(markerPath);

  if (location.adjacentEntry !== undefined && status.entry === 'present') {
    await unlinkValidatedEntry(location.adjacentEntry, expectedInstallationId);
  }

  await removeChildrenExceptMarker(location.managedDir);
  await testDeps?.failpoint?.('content_removed');
  await unlink(markerPath);
  try {
    await rmdir(location.managedDir);
  } catch (error) {
    await writeDurable(markerPath, markerBytes);
    await chmod(markerPath, markerStat.mode & 0o777);
    throw error;
  }
}

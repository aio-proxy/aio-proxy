import type { Dirent } from 'node:fs';
import { chmod, lstat, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AgentManagedMarkerSchema } from '@aio-proxy/types';

import type { AgentLocation } from '../hosts';
import {
  captureIdentity,
  inspectPath,
  isFsCode,
  matchesIdentity,
  relocateIdentity,
  removeOwned,
  restoreOwned,
  writeDurable,
  type FsIdentity,
} from './durable';
import { inspectManagedInstallation, openCodeEntry } from './inspect';

export type ManagedRemoveTestDeps = {
  readonly failpoint?: (point: 'content_removed') => void | Promise<void>;
};
export type ManagedRemovePrivateTestDeps = ManagedRemoveTestDeps & {
  readonly onValidated?: () => void | Promise<void>;
  readonly onBeforeContentRemoval?: () => void | Promise<void>;
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

const requireOwned = async (identity: FsIdentity, message: string) => {
  const current = await inspectPath(identity.path);
  if (current === undefined || !matchesIdentity(identity, current)) throw new Error(message);
  return current;
};

const isolateValidatedDirectory = async (dir: FsIdentity): Promise<FsIdentity> => {
  const isolated = join(dirname(dir.path), `.aio-proxy-owned-${crypto.randomUUID()}`);
  try {
    await rename(dir.path, isolated);
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) throw new Error('managed directory replaced');
    throw error;
  }
  const stat = await inspectPath(isolated);
  if (stat !== undefined && matchesIdentity(dir, stat)) return relocateIdentity(dir, isolated);
  if (stat !== undefined && (await inspectPath(dir.path)) === undefined) {
    try {
      await rename(isolated, dir.path);
    } catch {
      // Keep the unmatched occupant on the owned sibling rather than deleting it.
    }
  }
  throw new Error('managed directory replaced');
};

const bindAdjacentEntry = async (path: string, installationId: string): Promise<FsIdentity | undefined> => {
  const stat = await inspectPath(path);
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('entry conflict');
  if (!(await readFile(path)).equals(Buffer.from(openCodeEntry(installationId)))) {
    throw new Error('entry conflict');
  }
  const again = await lstat(path);
  if (again.isSymbolicLink() || !again.isFile() || !matchesIdentity({ path, dev: stat.dev, ino: stat.ino }, again)) {
    throw new Error('entry conflict');
  }
  return { path, dev: stat.dev, ino: stat.ino };
};

async function runManagedRemove(
  location: AgentLocation,
  expectedInstallationId: string,
  testDeps?: ManagedRemovePrivateTestDeps,
): Promise<void> {
  const status = await inspectManagedInstallation(location, Date.now);
  if (status.integration === 'conflict') {
    throw new Error(status.reason === 'entry_invalid' ? 'entry conflict' : `managed ${status.reason ?? 'conflict'}`);
  }
  if (
    status.integration !== 'managed' ||
    status.marker === undefined ||
    status.marker.installationId !== expectedInstallationId
  ) {
    throw new Error('managed installation is required');
  }

  const directory = await lstat(location.managedDir);
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('managed directory invalid');
  const dir = await captureIdentity(location.managedDir);

  const markerPath = join(location.managedDir, MARKER_NAME);
  const markerStat = await lstat(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) throw new Error('managed marker invalid');
  const markerBytes = await readFile(markerPath);
  let parsed: ReturnType<typeof AgentManagedMarkerSchema.safeParse>;
  try {
    parsed = AgentManagedMarkerSchema.safeParse(JSON.parse(markerBytes.toString('utf8')));
  } catch {
    throw new Error('managed marker invalid');
  }
  if (
    !parsed.success ||
    parsed.data.agent !== location.target ||
    parsed.data.installationId !== expectedInstallationId
  ) {
    throw new Error('managed marker invalid');
  }
  const markerAgain = await lstat(markerPath);
  if (!matchesIdentity({ path: markerPath, dev: markerStat.dev, ino: markerStat.ino }, markerAgain)) {
    throw new Error('managed marker invalid');
  }
  await requireOwned(dir, 'managed directory replaced');
  const marker = { path: markerPath, dev: markerStat.dev, ino: markerStat.ino };

  const entry =
    location.adjacentEntry === undefined
      ? undefined
      : await bindAdjacentEntry(location.adjacentEntry, expectedInstallationId);

  await testDeps?.onValidated?.();
  await requireOwned(dir, 'managed directory replaced');
  if (entry !== undefined) await requireOwned(entry, 'entry conflict');
  await requireOwned(marker, 'managed marker invalid');
  await requireOwned(dir, 'managed directory replaced');
  await testDeps?.onBeforeContentRemoval?.();
  const isolatedDir = await isolateValidatedDirectory(dir);
  const isolatedMarker = relocateIdentity(marker, join(isolatedDir.path, MARKER_NAME));
  if (entry !== undefined) await removeOwned(entry);
  await requireOwned(isolatedDir, 'managed directory replaced');
  await requireOwned(isolatedMarker, 'managed marker invalid');
  await removeChildrenExceptMarker(isolatedDir.path);
  if (!(await restoreOwned(isolatedDir, location.managedDir))) throw new Error('managed directory replaced');
  const restoredDir = relocateIdentity(isolatedDir, location.managedDir);
  const restoredMarker = relocateIdentity(isolatedMarker, markerPath);
  await testDeps?.failpoint?.('content_removed');
  await requireOwned(restoredDir, 'managed directory replaced');
  await requireOwned(restoredMarker, 'managed marker invalid');
  await removeOwned(restoredMarker);
  try {
    await rmdir(location.managedDir);
  } catch (error) {
    const stillOurs = await inspectPath(location.managedDir);
    if (stillOurs !== undefined && matchesIdentity(restoredDir, stillOurs)) {
      await writeDurable(markerPath, markerBytes);
      await chmod(markerPath, markerStat.mode & 0o777);
    }
    throw error;
  }
}

export async function removeManagedIntegration(
  location: AgentLocation,
  expectedInstallationId: string,
  testDeps?: ManagedRemoveTestDeps,
): Promise<void> {
  return runManagedRemove(location, expectedInstallationId, testDeps);
}

export async function removeManagedIntegrationForTest(
  location: AgentLocation,
  expectedInstallationId: string,
  testDeps?: ManagedRemovePrivateTestDeps,
): Promise<void> {
  return runManagedRemove(location, expectedInstallationId, testDeps);
}

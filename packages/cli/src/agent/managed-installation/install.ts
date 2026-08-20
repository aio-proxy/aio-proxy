import { link, lstat, mkdir, mkdtemp, readFile, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import {
  AgentManagedMarkerSchema,
  AgentManagedStateV1Schema,
  type AgentManagedMarker,
  type AgentTarget,
} from '@aio-proxy/types';

import type { AgentLocation } from '../hosts';
import {
  captureIdentity,
  inspectPath,
  isFsCode,
  matchesIdentity,
  relocateIdentity,
  removeOwned,
  restoreOwned,
  syncDirectory,
  writeDurable,
  type FsIdentity,
} from './durable';
import { inspectManagedInstallation, openCodeEntry, type LocalIntegrationStatus } from './inspect';

export type ManagedInstallInput = {
  readonly location: AgentLocation;
  readonly endpoint: string;
  readonly adapterVersion: string;
  readonly requestedInstallationId: string;
  readonly readAssets: () => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly managedOnly?: boolean;
};
export type ManagedInstallTestDeps = {
  readonly failpoint?: (point: 'staged' | 'backed_up' | 'directory_swapped' | 'entry_ready') => void | Promise<void>;
};
export type ManagedInstallPrivateTestDeps = ManagedInstallTestDeps & {
  readonly onEntryLinked?: () => void | Promise<void>;
  readonly onBackupCleanup?: () => void | Promise<void>;
};

const throwConflict = (status: LocalIntegrationStatus): never => {
  throw new Error(status.reason === 'entry_invalid' ? 'entry conflict' : `managed ${status.reason ?? 'conflict'}`);
};

const isNewerAdapter = (existing: string, requested: string): boolean => Bun.semver.order(existing, requested) > 0;

const resolveAssetPath = (stagingDir: string, relativePath: string): string => {
  if (isAbsolute(relativePath)) throw new Error(`asset path must be relative: ${relativePath}`);
  if (relativePath.split(/[/\\]/u).some((segment) => segment === '' || segment === '..')) {
    throw new Error(`asset path is unsafe: ${relativePath}`);
  }
  return join(stagingDir, relativePath);
};

const writeStagingTree = async (
  stagingDir: string,
  assets: ReadonlyMap<string, Uint8Array>,
  marker: AgentManagedMarker,
): Promise<void> => {
  for (const [relativePath, bytes] of assets) {
    const absolute = resolveAssetPath(stagingDir, relativePath);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    await writeDurable(absolute, bytes);
  }
  await writeDurable(
    join(stagingDir, '.aio-proxy-managed.json'),
    `${JSON.stringify(AgentManagedMarkerSchema.parse(marker))}\n`,
  );
  await syncDirectory(stagingDir);
};

const validateBackup = async (
  backupDir: string,
  target: AgentTarget,
  installationId: string,
  adapterVersion: string,
): Promise<'ok' | 'newer'> => {
  const directory = await inspectPath(backupDir);
  if (directory === undefined || directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error('managed backup invalid');
  }
  const markerPath = join(backupDir, '.aio-proxy-managed.json');
  const markerStat = await inspectPath(markerPath);
  if (markerStat === undefined || markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error('managed marker invalid');
  }
  let parsed: ReturnType<typeof AgentManagedMarkerSchema.safeParse>;
  try {
    parsed = AgentManagedMarkerSchema.safeParse(JSON.parse(await readFile(markerPath, 'utf8')));
  } catch {
    throw new Error('managed marker invalid');
  }
  if (!parsed.success || parsed.data.agent !== target || parsed.data.installationId !== installationId) {
    throw new Error('managed marker invalid');
  }
  return isNewerAdapter(parsed.data.adapterVersion, adapterVersion) ? 'newer' : 'ok';
};

const copyValidState = async (backupDir: string, stagingDir: string, target: AgentTarget): Promise<void> => {
  const statePath = join(backupDir, '.aio-proxy-state.json');
  const stat = await inspectPath(statePath);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) return;
  const raw = await readFile(statePath);
  let parsed: ReturnType<typeof AgentManagedStateV1Schema.safeParse>;
  try {
    parsed = AgentManagedStateV1Schema.safeParse(JSON.parse(raw.toString('utf8')));
  } catch {
    return;
  }
  if (!parsed.success || (parsed.data.lkg !== null && parsed.data.lkg.agent !== target)) return;
  await writeDurable(join(stagingDir, '.aio-proxy-state.json'), raw);
  await syncDirectory(stagingDir);
};

const commitOpenCodeEntry = async (
  adjacentEntry: string,
  installationId: string,
  testDeps?: ManagedInstallPrivateTestDeps,
  onLinked?: () => void,
): Promise<void> => {
  const existing = await inspectPath(adjacentEntry);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) throw new Error('entry is a symlink');
    if (!existing.isFile()) throw new Error('entry exists');
    if ((await readFile(adjacentEntry)).equals(Buffer.from(openCodeEntry(installationId)))) return;
    throw new Error('entry conflict');
  }

  const temporary = join(dirname(adjacentEntry), `.aio-proxy-entry-${crypto.randomUUID()}`);
  await writeDurable(temporary, openCodeEntry(installationId));
  const temp = await captureIdentity(temporary);
  try {
    await testDeps?.failpoint?.('entry_ready');
    await link(temporary, adjacentEntry);
  } catch (error) {
    await removeOwned(temp);
    if (isFsCode(error, 'EEXIST')) throw new Error('entry already exists');
    throw error;
  }
  onLinked?.();
  try {
    await testDeps?.onEntryLinked?.();
    await removeOwned(temp);
    await syncDirectory(dirname(adjacentEntry));
  } catch (error) {
    await removeOwned(temp);
    throw error;
  }
};

const repairOpenCodeEntry = async (location: AgentLocation, marker: AgentManagedMarker): Promise<void> => {
  const markerPath = join(location.managedDir, '.aio-proxy-managed.json');
  const markerStat = await lstat(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) throw new Error('managed marker invalid');
  const adjacent = location.adjacentEntry;
  if (adjacent === undefined) return;
  const entryStat = await inspectPath(adjacent);
  if (entryStat !== undefined) {
    if (entryStat.isSymbolicLink()) throw new Error('entry is a symlink');
    if (!entryStat.isFile() || !(await readFile(adjacent)).equals(Buffer.from(openCodeEntry(marker.installationId)))) {
      throw new Error('entry conflict');
    }
    return;
  }
  await commitOpenCodeEntry(adjacent, marker.installationId);
};

const reserveSibling = async (hostRoot: string, prefix: string): Promise<string> => {
  const reserved = await mkdtemp(join(hostRoot, prefix));
  await rmdir(reserved);
  return reserved;
};

const reserveVacantManagedDir = async (path: string): Promise<FsIdentity> => {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isFsCode(error, 'EEXIST')) throw new Error('managed path exists');
    throw error;
  }
  return captureIdentity(path);
};

const promoteStagedDir = async (staging: FsIdentity, dest: string): Promise<void> => {
  const reservation = await reserveVacantManagedDir(dest);
  try {
    await rename(staging.path, dest);
  } catch (error) {
    const current = await inspectPath(dest);
    if (current !== undefined && matchesIdentity(reservation, current)) await rmdir(dest);
    throw error;
  }
};

const runStagedInstall = async (
  input: ManagedInstallInput,
  installationId: string,
  updating: boolean,
  testDeps?: ManagedInstallPrivateTestDeps,
): Promise<'installed' | 'updated' | 'newer'> => {
  const { location } = input;
  await mkdir(location.hostRoot, { recursive: true, mode: 0o700 });
  const assets = await input.readAssets();

  let staging: FsIdentity | undefined;
  let backup: FsIdentity | undefined;
  let promoted = false;
  let committed = false;

  try {
    const stagingDir = await mkdtemp(join(location.hostRoot, '.aio-proxy-stage-'));
    staging = await captureIdentity(stagingDir);
    await writeStagingTree(stagingDir, assets, {
      format: 1,
      managedBy: 'aio-proxy',
      agent: location.target,
      installationId,
      adapterVersion: input.adapterVersion,
      endpoint: input.endpoint,
    });
    await testDeps?.failpoint?.('staged');

    if (updating) {
      const reserved = await reserveSibling(location.hostRoot, '.aio-proxy-backup-');
      await rename(location.managedDir, reserved);
      backup = await captureIdentity(reserved);
      await testDeps?.failpoint?.('backed_up');
      if ((await validateBackup(reserved, location.target, installationId, input.adapterVersion)) === 'newer') {
        if (!(await restoreOwned(backup, location.managedDir))) {
          throw new Error('managed backup restore failed');
        }
        backup = undefined;
        return 'newer';
      }
      await copyValidState(reserved, stagingDir, location.target);
    }

    await promoteStagedDir(staging, location.managedDir);
    staging = relocateIdentity(staging, location.managedDir);
    promoted = true;
    await testDeps?.failpoint?.('directory_swapped');

    if (location.adjacentEntry !== undefined) {
      await commitOpenCodeEntry(location.adjacentEntry, installationId, testDeps, () => {
        committed = true;
      });
    }
    committed = true;

    if (backup !== undefined) {
      await testDeps?.onBackupCleanup?.();
      await removeOwned(backup);
      backup = undefined;
    }
    return updating ? 'updated' : 'installed';
  } catch (error) {
    if (!committed) {
      if (promoted && staging !== undefined) await removeOwned(staging);
      if (backup !== undefined) await restoreOwned(backup, location.managedDir);
    }
    throw error;
  } finally {
    if (!promoted && staging !== undefined) await removeOwned(staging);
  }
};

async function runManagedInstall(
  input: ManagedInstallInput,
  testDeps?: ManagedInstallPrivateTestDeps,
): Promise<'installed' | 'updated' | 'newer'> {
  const { location } = input;
  const status = await inspectManagedInstallation(location, Date.now);
  if (status.integration === 'conflict') throwConflict(status);

  if (status.integration === 'managed') {
    const { marker } = status;
    if (marker === undefined) throw new Error('managed installation is required');
    if (input.managedOnly === true && marker.installationId !== input.requestedInstallationId) {
      throw new Error('managed installation id mismatch');
    }
    if (isNewerAdapter(marker.adapterVersion, input.adapterVersion)) {
      if (location.adjacentEntry !== undefined && status.entry === 'missing') {
        await repairOpenCodeEntry(location, marker);
      }
      return 'newer';
    }
    return runStagedInstall(input, marker.installationId, true, testDeps);
  }

  if (input.managedOnly === true) throw new Error('managed installation is required');
  return runStagedInstall(input, input.requestedInstallationId, false, testDeps);
}

export async function installManagedIntegration(
  input: ManagedInstallInput,
  testDeps?: ManagedInstallTestDeps,
): Promise<'installed' | 'updated' | 'newer'> {
  return runManagedInstall(input, testDeps);
}

export async function installManagedIntegrationForTest(
  input: ManagedInstallInput,
  testDeps?: ManagedInstallPrivateTestDeps,
): Promise<'installed' | 'updated' | 'newer'> {
  return runManagedInstall(input, testDeps);
}

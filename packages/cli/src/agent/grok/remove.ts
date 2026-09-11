import type { FileLock } from '@aio-proxy/core';
import type { AgentRevokeStatus } from '@aio-proxy/types';

import {
  assertSafePrivateDir,
  assertSafeRoot,
  captureIdentity,
  grokPaths,
  inspectPath,
  listGrokDirectoryNames,
  readGrokFile,
  readGrokPrivateFile,
  removeGrokOwnedTemporaryFiles,
  removeMatchingDir,
  removeMatchingFile,
  unlinkGrokFile,
  type GrokFileIdentity,
  type GrokPaths,
  type ReplaceGrokFileTestDeps,
} from './files';
import {
  commitGrokEdit,
  configTextOrEmpty,
  createBudget,
  loadManaged,
  persistOwnership,
  withGrokLock,
  type ManagedState,
} from './lifecycle';
import { adoptRecoveredOwnership, isCompletedGrokRemoval, parseGrokOwnership, recoverGrokOwnership } from './ownership';
import { restoreGrokToml } from './toml';
import type { GrokDeadline, GrokDeps, GrokOwnership, TomlEdit } from './types';

export type GrokRemoveFailPoint =
  | 'removing'
  | 'revoked'
  | 'credential'
  | 'ownership_pending'
  | 'config'
  | 'ownership_committed'
  | 'cleanup_complete'
  | 'marker_removed';

export type GrokRemoveTestDeps = ReplaceGrokFileTestDeps & {
  readonly failpoint?: (point: GrokRemoveFailPoint) => void | Promise<void>;
};

export type GrokRemoveResult = {
  readonly installationId: string;
  readonly revokeStatus: AgentRevokeStatus;
  readonly skippedFields: readonly string[];
  readonly retainedFiles: readonly string[];
};

const conflictExisting = (): never => {
  throw new Error('Grok private directory already exists');
};

async function credentialAbsent(paths: GrokPaths): Promise<boolean> {
  const snapshot = await readGrokPrivateFile(paths.credential, 'credential');
  return snapshot === undefined || snapshot.text.trim() === '';
}

async function unlinkKnownFile(
  lock: FileLock,
  identity: GrokFileIdentity | undefined,
  budget: GrokDeadline,
): Promise<void> {
  if (identity === undefined) return;
  await lock.withOwnershipFence(async (assertFenced) => {
    budget.signal.throwIfAborted();
    await assertFenced();
    await removeMatchingFile(identity);
  });
}

async function retainedPrivateNames(paths: GrokPaths, privateDir: GrokFileIdentity): Promise<readonly string[]> {
  const current = await inspectPath(paths.privateDir);
  if (current === undefined || current.dev !== privateDir.dev || current.ino !== privateDir.ino) return [];
  return [...(await listGrokDirectoryNames(paths.privateDir))].sort();
}

async function cleanupPrivateDir(
  lock: FileLock,
  paths: GrokPaths,
  privateDir: GrokFileIdentity,
  marker: GrokFileIdentity | undefined,
  ownership: GrokFileIdentity | undefined,
  budget: GrokDeadline,
  testDeps?: GrokRemoveTestDeps,
): Promise<readonly string[]> {
  await removeGrokOwnedTemporaryFiles(paths);
  const credential = await inspectPath(paths.credential);
  if (credential !== undefined && !credential.isSymbolicLink() && credential.isFile()) {
    await unlinkKnownFile(lock, { path: paths.credential, dev: credential.dev, ino: credential.ino }, budget);
  }
  await unlinkKnownFile(lock, marker, budget);
  await testDeps?.failpoint?.('marker_removed');
  await unlinkKnownFile(lock, ownership, budget);
  await removeMatchingDir(privateDir);
  return retainedPrivateNames(paths, privateDir);
}

function requireCompletedOwnership(text: string): GrokOwnership {
  let ownership: GrokOwnership;
  try {
    ownership = parseGrokOwnership(text);
  } catch {
    return conflictExisting();
  }
  if (!isCompletedGrokRemoval(ownership)) return conflictExisting();
  return ownership;
}

async function narrowCompletedRemoval(
  lock: FileLock,
  paths: GrokPaths,
  privateDir: GrokFileIdentity,
  budget: GrokDeadline,
  testDeps?: GrokRemoveTestDeps,
): Promise<GrokRemoveResult> {
  const ownershipFile = await readGrokPrivateFile(paths.ownership, 'ownership');
  if (ownershipFile === undefined) return conflictExisting();
  const ownership = requireCompletedOwnership(ownershipFile.text);
  if (!(await credentialAbsent(paths))) return conflictExisting();
  const retainedFiles = await cleanupPrivateDir(
    lock,
    paths,
    privateDir,
    undefined,
    { path: paths.ownership, dev: ownershipFile.dev, ino: ownershipFile.ino },
    budget,
    testDeps,
  );
  return {
    installationId: ownership.installationId,
    revokeStatus: 'revoked',
    skippedFields: [],
    retainedFiles,
  };
}

function removingOwnership(ownership: GrokOwnership): GrokOwnership {
  return {
    format: 1,
    agent: 'grok',
    installationId: ownership.installationId,
    endpoint: ownership.endpoint,
    status: 'removing',
    leaves: ownership.leaves,
    createdTables: ownership.createdTables,
    ...(ownership.pending === undefined ? {} : { pending: ownership.pending }),
  };
}

function completedOwnership(ownership: GrokOwnership): GrokOwnership {
  return {
    format: 1,
    agent: 'grok',
    installationId: ownership.installationId,
    endpoint: ownership.endpoint,
    status: 'removing',
    leaves: ownership.leaves,
    createdTables: ownership.createdTables,
    cleanupComplete: true,
  };
}

async function removeManaged(
  lock: FileLock,
  paths: GrokPaths,
  privateDir: GrokFileIdentity,
  deps: GrokDeps,
  budget: GrokDeadline,
  loaded: ManagedState,
  testDeps?: GrokRemoveTestDeps,
): Promise<GrokRemoveResult> {
  const recovered = recoverGrokOwnership(configTextOrEmpty(loaded.config), loaded.ownership);
  const adopted = adoptRecoveredOwnership(loaded.ownership, loaded.ownershipFile.text, recovered);
  let ownership = adopted.ownership;
  let ownershipFile = loaded.ownershipFile;
  let config = loaded.config;
  const markerFile = loaded.markerFile;
  const marker = loaded.marker;

  const saveOwnership = async (next: GrokOwnership): Promise<void> => {
    ownershipFile = await persistOwnership(lock, paths, next, ownershipFile, budget);
    ownership = next;
  };

  const commitEdit = async (edit: TomlEdit): Promise<void> => {
    const result = await commitGrokEdit(lock, paths, 'remove', edit, ownership, config, ownershipFile, budget, {
      beforeRename: testDeps?.beforeRename,
      failpoint: async (point) => {
        if (point === 'ownership_pending' || point === 'config' || point === 'ownership_committed') {
          await testDeps?.failpoint?.(point);
        }
      },
    });
    ownership = result.ownership;
    ownershipFile = result.ownershipFile;
    config = await readGrokFile(paths.config);
  };

  if (adopted.persist) await saveOwnership(ownership);
  if (ownership.status !== 'removing') await saveOwnership(removingOwnership(ownership));
  await testDeps?.failpoint?.('removing');

  let revokeStatus: AgentRevokeStatus = 'revoked';
  let skippedFields: readonly string[] = [];
  if (!isCompletedGrokRemoval(ownership)) {
    revokeStatus = await deps.revoke(marker.endpoint, marker.installationId);
    await testDeps?.failpoint?.('revoked');
    const expectedCredential = await readGrokPrivateFile(paths.credential, 'credential');
    await lock.withOwnershipFence(async (assertFenced) => {
      await unlinkGrokFile(paths.credential, expectedCredential, budget, assertFenced);
    });
    await testDeps?.failpoint?.('credential');
    config = await readGrokFile(paths.config);
    const edit = restoreGrokToml(config?.text ?? '', ownership.leaves, ownership.createdTables);
    skippedFields = edit.skipped;
    await commitEdit(edit);
    await saveOwnership(completedOwnership(ownership));
    await testDeps?.failpoint?.('cleanup_complete');
  }

  const retainedFiles = await cleanupPrivateDir(
    lock,
    paths,
    privateDir,
    { path: paths.marker, dev: markerFile.dev, ino: markerFile.ino },
    { path: paths.ownership, dev: ownershipFile.dev, ino: ownershipFile.ino },
    budget,
    testDeps,
  );
  return {
    installationId: marker.installationId,
    revokeStatus,
    skippedFields,
    retainedFiles,
  };
}

async function removeGrokInternal(
  root: string,
  adapterVersion: string,
  deps: GrokDeps,
  testDeps?: GrokRemoveTestDeps,
): Promise<GrokRemoveResult> {
  const budget = createBudget(deps.now);
  const paths = grokPaths(root);
  return withGrokLock(root, budget, async (lock) =>
    lock.withOwnership(async () => {
      budget.signal.throwIfAborted();
      const rootStat = await inspectPath(paths.root);
      if (rootStat === undefined) throw new Error('Grok root is not a directory');
      assertSafeRoot(rootStat);
      const privateStat = await inspectPath(paths.privateDir);
      if (privateStat === undefined) throw new Error('Grok installation missing');
      assertSafePrivateDir(privateStat);
      const privateDir = await captureIdentity(paths.privateDir);
      const markerFile = await readGrokPrivateFile(paths.marker, 'marker');
      if (markerFile === undefined) {
        return narrowCompletedRemoval(lock, paths, privateDir, budget, testDeps);
      }
      const loaded = await loadManaged(paths, adapterVersion);
      if ('newer' in loaded) throw new Error('Grok configuration is newer');
      return removeManaged(lock, paths, privateDir, deps, budget, loaded, testDeps);
    }),
  );
}

export async function removeGrok(root: string, adapterVersion: string, deps: GrokDeps): Promise<GrokRemoveResult> {
  return removeGrokInternal(root, adapterVersion, deps);
}

export async function removeGrokForTest(
  root: string,
  adapterVersion: string,
  deps: GrokDeps,
  testDeps: GrokRemoveTestDeps,
): Promise<GrokRemoveResult> {
  return removeGrokInternal(root, adapterVersion, deps, testDeps);
}

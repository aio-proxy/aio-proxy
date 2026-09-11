import type { FileLock } from '@aio-proxy/core';
import type { AgentRevokeStatus } from '@aio-proxy/types';

import {
  assertSafePrivateDir,
  assertSafeRoot,
  captureIdentity,
  grokPaths,
  inspectPath,
  readGrokFile,
  readGrokPrivateFile,
  unlinkGrokFile,
  type GrokFileIdentity,
  type GrokPaths,
} from './files';
import {
  commitGrokEdit,
  configTextOrEmpty,
  createBudget,
  loadManaged,
  persistOwnership,
  restoreOwnershipFromRemovalJournal,
  withGrokLock,
  type ManagedState,
} from './lifecycle';
import {
  adoptRecoveredOwnership,
  isBootstrapGrokJournal,
  isCompletedGrokRemoval,
  isIncompleteRebind,
  parseGrokMarker,
  parseGrokOwnership,
  recoverGrokOwnership,
} from './ownership';
import {
  cleanupPrivateDir,
  conflictExisting,
  finishRootRemovalJournal,
  narrowBootstrapRemoval,
  narrowCompletedRemoval,
  skippedFieldsFromOwnership,
  type GrokRemoveFailPoint,
  type GrokRemoveResult,
  type GrokRemoveTestDeps,
} from './remove-cleanup';
import { restoreGrokToml } from './toml';
import type { GrokDeadline, GrokDeps, GrokOwnership, TomlEdit } from './types';

export type { GrokRemoveFailPoint, GrokRemoveResult, GrokRemoveTestDeps };

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

function revokedOwnership(ownership: GrokOwnership, revokeStatus: AgentRevokeStatus): GrokOwnership {
  return {
    format: 1,
    agent: 'grok',
    installationId: ownership.installationId,
    endpoint: ownership.endpoint,
    status: 'removing',
    leaves: ownership.leaves,
    createdTables: ownership.createdTables,
    ...(ownership.pending === undefined ? {} : { pending: ownership.pending }),
    revokeStatus,
  };
}

function completedOwnership(ownership: GrokOwnership, revokeStatus: AgentRevokeStatus): GrokOwnership {
  return {
    format: 1,
    agent: 'grok',
    installationId: ownership.installationId,
    endpoint: ownership.endpoint,
    status: 'removing',
    leaves: ownership.leaves,
    createdTables: ownership.createdTables,
    cleanupComplete: true,
    revokeStatus,
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
    config = await readGrokFile(paths.config, budget);
  };

  if (adopted.persist) await saveOwnership(ownership);
  if (ownership.status !== 'removing') await saveOwnership(removingOwnership(ownership));
  await testDeps?.failpoint?.('removing');

  let revokeStatus: AgentRevokeStatus;
  let skippedFields: readonly string[] = [];
  if (ownership.revokeStatus === undefined) {
    revokeStatus = await deps.revoke(marker.endpoint, marker.installationId);
    await saveOwnership(revokedOwnership(ownership, revokeStatus));
    await testDeps?.failpoint?.('revoked');
  } else {
    revokeStatus = ownership.revokeStatus;
  }
  if (!isCompletedGrokRemoval(ownership)) {
    const expectedCredential = await readGrokPrivateFile(paths.credential, 'credential', budget);
    await lock.withOwnershipFence(async (assertFenced) => {
      await unlinkGrokFile(paths.credential, expectedCredential, budget, assertFenced);
    });
    await testDeps?.failpoint?.('credential');
    config = await readGrokFile(paths.config, budget);
    const edit = restoreGrokToml(config?.text ?? '', ownership.leaves, ownership.createdTables);
    skippedFields = edit.skipped;
    await commitEdit(edit);
    await saveOwnership(completedOwnership(ownership, revokeStatus));
    await testDeps?.failpoint?.('cleanup_complete');
  } else {
    skippedFields = skippedFieldsFromOwnership(ownership);
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
      if (privateStat === undefined) return finishRootRemovalJournal(lock, paths, budget);
      assertSafePrivateDir(privateStat);
      const privateDir = await captureIdentity(paths.privateDir);
      const markerFile = await readGrokPrivateFile(paths.marker, 'marker', budget);
      if (markerFile === undefined) {
        const ownershipFile =
          (await readGrokPrivateFile(paths.ownership, 'ownership', budget)) ??
          (await restoreOwnershipFromRemovalJournal(lock, paths, budget));
        if (ownershipFile !== undefined) {
          try {
            const ownership = parseGrokOwnership(ownershipFile.text);
            if (isBootstrapGrokJournal(ownership)) {
              return narrowBootstrapRemoval(lock, paths, privateDir, budget, testDeps);
            }
          } catch {
            return conflictExisting();
          }
        }
        return narrowCompletedRemoval(lock, paths, privateDir, budget, testDeps);
      }
      const ownershipForRebind =
        (await readGrokPrivateFile(paths.ownership, 'ownership', budget)) ??
        (await restoreOwnershipFromRemovalJournal(lock, paths, budget));
      if (ownershipForRebind !== undefined) {
        try {
          const ownership = parseGrokOwnership(ownershipForRebind.text);
          if (isIncompleteRebind(ownership, parseGrokMarker(markerFile.text))) {
            return narrowBootstrapRemoval(lock, paths, privateDir, budget, testDeps);
          }
        } catch {
          // loadManaged reports foreign or invalid leftovers.
        }
      }
      const loaded = await loadManaged(paths, adapterVersion, budget);
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

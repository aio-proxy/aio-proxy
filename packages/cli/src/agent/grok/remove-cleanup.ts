import type { FileLock } from '@aio-proxy/core';
import type { AgentRevokeStatus } from '@aio-proxy/types';

import {
  inspectPath,
  listGrokDirectoryNames,
  readGrokPrivateFile,
  removeGrokOwnedTemporaryFiles,
  removeMatchingDir,
  removeMatchingFile,
  tryReadGrokPrivateFile,
  type GrokFileIdentity,
  type GrokPaths,
  type ReplaceGrokFileTestDeps,
} from './files';
import {
  clearRemovalJournal,
  persistRemovalJournal,
  readRemovalJournal,
  restoreOwnershipFromRemovalJournal,
} from './lifecycle';
import { isBootstrapGrokJournal, isCompletedGrokRemoval, parseGrokOwnership } from './ownership';
import { equalGrokLeaf } from './toml';
import type { GrokDeadline, GrokOwnership } from './types';

export type GrokRemoveFailPoint =
  | 'removing'
  | 'revoked'
  | 'credential'
  | 'ownership_pending'
  | 'config'
  | 'ownership_committed'
  | 'cleanup_complete'
  | 'marker_removed'
  | 'ownership_removed';

export type GrokRemoveTestDeps = ReplaceGrokFileTestDeps & {
  readonly failpoint?: (point: GrokRemoveFailPoint) => void | Promise<void>;
};

export type GrokRemoveResult = {
  readonly installationId: string;
  readonly revokeStatus: AgentRevokeStatus;
  readonly skippedFields: readonly string[];
  readonly retainedFiles: readonly string[];
};

export const conflictExisting = (): never => {
  throw new Error('Grok private directory already exists');
};

export function skippedFieldsFromOwnership(ownership: GrokOwnership): readonly string[] {
  return ownership.leaves
    .filter((leaf) => !equalGrokLeaf(leaf.written, leaf.original))
    .map((leaf) => leaf.path.join('.'));
}

async function credentialAbsent(paths: GrokPaths, budget: GrokDeadline): Promise<boolean> {
  const snapshot = await readGrokPrivateFile(paths.credential, 'credential', budget);
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

const REMOVAL_JOURNAL_NAMES = new Set(['.aio-proxy-managed.json', 'ownership.json']);

async function retainedPrivateNames(paths: GrokPaths, privateDir: GrokFileIdentity): Promise<readonly string[]> {
  const current = await inspectPath(paths.privateDir);
  if (current === undefined || current.dev !== privateDir.dev || current.ino !== privateDir.ino) return [];
  return [...(await listGrokDirectoryNames(paths.privateDir))].sort();
}

async function unknownRetainedNames(paths: GrokPaths, privateDir: GrokFileIdentity): Promise<readonly string[]> {
  return (await retainedPrivateNames(paths, privateDir)).filter((name) => !REMOVAL_JOURNAL_NAMES.has(name));
}

export async function cleanupPrivateDir(
  lock: FileLock,
  paths: GrokPaths,
  privateDir: GrokFileIdentity,
  marker: GrokFileIdentity | undefined,
  ownership: GrokFileIdentity | undefined,
  budget: GrokDeadline,
  testDeps?: GrokRemoveTestDeps,
): Promise<readonly string[]> {
  await removeGrokOwnedTemporaryFiles(paths);
  const leftoverCredential = await tryReadGrokPrivateFile(paths.credential, 'credential', budget);
  if (leftoverCredential !== undefined) {
    await unlinkKnownFile(
      lock,
      { path: paths.credential, dev: leftoverCredential.dev, ino: leftoverCredential.ino },
      budget,
    );
  }
  const retained = await unknownRetainedNames(paths, privateDir);
  if (retained.length > 0) return retained;
  if (ownership !== undefined) {
    const current = await readGrokPrivateFile(paths.ownership, 'ownership', budget);
    if (current !== undefined) await persistRemovalJournal(lock, paths, current.text, budget);
  }
  await unlinkKnownFile(lock, marker, budget);
  await testDeps?.failpoint?.('marker_removed');
  if (ownership !== undefined) {
    await unlinkKnownFile(lock, ownership, budget);
    await testDeps?.failpoint?.('ownership_removed');
  }
  await removeMatchingDir(privateDir);
  const leftover = await unknownRetainedNames(paths, privateDir);
  if (leftover.length === 0 && (await inspectPath(paths.privateDir)) === undefined) {
    await clearRemovalJournal(lock, paths, budget);
  } else if (leftover.length > 0) {
    await restoreOwnershipFromRemovalJournal(lock, paths, budget);
  }
  return leftover;
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

export async function narrowCompletedRemoval(
  lock: FileLock,
  paths: GrokPaths,
  privateDir: GrokFileIdentity,
  budget: GrokDeadline,
  testDeps?: GrokRemoveTestDeps,
): Promise<GrokRemoveResult> {
  const ownershipFile =
    (await readGrokPrivateFile(paths.ownership, 'ownership', budget)) ??
    (await restoreOwnershipFromRemovalJournal(lock, paths, budget));
  if (ownershipFile === undefined) return conflictExisting();
  const ownership = requireCompletedOwnership(ownershipFile.text);
  if (!(await credentialAbsent(paths, budget))) return conflictExisting();
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
    revokeStatus: ownership.revokeStatus,
    skippedFields: skippedFieldsFromOwnership(ownership),
    retainedFiles,
  };
}

export async function narrowBootstrapRemoval(
  lock: FileLock,
  paths: GrokPaths,
  privateDir: GrokFileIdentity,
  budget: GrokDeadline,
  testDeps?: GrokRemoveTestDeps,
  marker?: GrokFileIdentity,
): Promise<GrokRemoveResult> {
  const ownershipFile = await readGrokPrivateFile(paths.ownership, 'ownership', budget);
  if (ownershipFile === undefined) return conflictExisting();
  const ownership = parseGrokOwnership(ownershipFile.text);
  if (!isBootstrapGrokJournal(ownership)) return conflictExisting();
  const retainedFiles = await cleanupPrivateDir(
    lock,
    paths,
    privateDir,
    marker,
    { path: paths.ownership, dev: ownershipFile.dev, ino: ownershipFile.ino },
    budget,
    testDeps,
  );
  return {
    installationId: ownership.installationId,
    revokeStatus: 'missing',
    skippedFields: [],
    retainedFiles,
  };
}

export async function finishRootRemovalJournal(
  lock: FileLock,
  paths: GrokPaths,
  budget: GrokDeadline,
): Promise<GrokRemoveResult> {
  const journal = await readRemovalJournal(paths, budget);
  if (journal === undefined) throw new Error('Grok installation missing');
  let ownership: GrokOwnership;
  try {
    ownership = parseGrokOwnership(journal.text);
  } catch {
    return conflictExisting();
  }
  if (isCompletedGrokRemoval(ownership)) {
    await clearRemovalJournal(lock, paths, budget);
    return {
      installationId: ownership.installationId,
      revokeStatus: ownership.revokeStatus,
      skippedFields: skippedFieldsFromOwnership(ownership),
      retainedFiles: [],
    };
  }
  if (isBootstrapGrokJournal(ownership)) {
    await clearRemovalJournal(lock, paths, budget);
    return {
      installationId: ownership.installationId,
      revokeStatus: 'missing',
      skippedFields: [],
      retainedFiles: [],
    };
  }
  return conflictExisting();
}

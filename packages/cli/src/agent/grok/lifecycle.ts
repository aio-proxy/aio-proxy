import { join } from 'node:path';

import { acquireFileLock, type FileLock } from '@aio-proxy/core';

import {
  readGrokFile,
  readGrokPrivateFile,
  replaceGrokFile,
  unlinkGrokFile,
  type GrokFileSnapshot,
  type GrokPaths,
  type ReplaceGrokFileTestDeps,
} from './files';
import {
  encodeGrokMarker,
  encodeGrokOwnership,
  isBootstrapGrokJournal,
  isCompletedGrokRemoval,
  isNewerAdapter,
  parseGrokMarker,
  parseGrokOwnership,
  peekManagedFormat,
} from './ownership';
import { checkGrokPolicy } from './policy';
import { equalGrokLeaf, readGrokLeaf } from './toml';
import type { GrokDeadline, GrokDeps, GrokMarker, GrokOwnership, GrokPath, TomlEdit } from './types';

export type GrokConfigureTestDeps = ReplaceGrokFileTestDeps & {
  readonly failpoint?: (
    point: 'private_dir' | 'ownership_pending' | 'marker' | 'config' | 'ownership_committed' | 'marker_version',
  ) => void | Promise<void>;
};

export type ManagedState = {
  readonly marker: GrokMarker;
  readonly markerFile: GrokFileSnapshot;
  readonly ownership: GrokOwnership;
  readonly ownershipFile: GrokFileSnapshot;
  readonly config: GrokFileSnapshot | undefined;
};

const GROK_OPERATION_MS = 15_000;

export const createBudget = (now: () => number): GrokDeadline => ({
  deadline: now() + GROK_OPERATION_MS,
  signal: AbortSignal.timeout(GROK_OPERATION_MS),
});

export const configTextOrEmpty = (config: GrokFileSnapshot | undefined): string => config?.text ?? '';

export const tryReadLeaf = (text: string, path: GrokPath) => {
  try {
    return readGrokLeaf(text, path);
  } catch {
    return undefined;
  }
};

export async function withGrokLock<T>(
  root: string,
  budget: GrokDeadline,
  action: (lock: FileLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock(join(root, '.aio-proxy.lock'), {
    deadline: budget.deadline,
    signal: budget.signal,
  });
  try {
    return await action(lock);
  } finally {
    await lock.release();
  }
}

export async function replaceOwnedFile(
  lock: FileLock,
  path: string,
  text: string,
  expected: GrokFileSnapshot | undefined,
  budget: GrokDeadline,
  testDeps?: ReplaceGrokFileTestDeps,
): Promise<void> {
  await lock.withOwnershipFence(async (assertOwnership) => {
    await replaceGrokFile(path, text, expected, budget, assertOwnership, testDeps);
  });
}

export async function assertGrokRoutingSafe(
  root: string,
  marker: GrokMarker,
  ownership: GrokOwnership,
  policy: GrokDeps['policy'],
  budget: GrokDeadline,
): Promise<void> {
  budget.signal.throwIfAborted();
  const path = join(root, 'config.toml');
  const snapshot = await readGrokFile(path, budget);
  if (snapshot === undefined) throw new Error('Grok configuration missing');
  for (const leaf of ownership.leaves) {
    if (!equalGrokLeaf(readGrokLeaf(snapshot.text, leaf.path), leaf.written)) {
      throw new Error('Grok configuration modified: ' + leaf.path.join('.'));
    }
  }
  const command = ownership.leaves.find(
    (leaf) =>
      leaf.path.length === 2 &&
      ['auth', 'grok_com_config'].includes(leaf.path[0]!) &&
      leaf.path[1] === 'auth_provider_command',
  )?.written;
  if (command?.present !== true) throw new Error('Grok auth command missing');
  const visible = await policy(root, budget);
  const conflicts = checkGrokPolicy(snapshot.text, marker.endpoint, command.value, visible);
  if (conflicts.length > 0) throw new Error('Grok routing conflict: ' + conflicts.join(', '));
  const latest = await readGrokFile(path, budget);
  if (
    latest === undefined ||
    latest.dev !== snapshot.dev ||
    latest.ino !== snapshot.ino ||
    latest.text !== snapshot.text ||
    latest.mode !== snapshot.mode
  ) {
    throw new Error('Grok configuration changed during authorization');
  }
  budget.signal.throwIfAborted();
}

export async function loadManaged(
  paths: GrokPaths,
  adapterVersion: string,
  budget?: GrokDeadline,
): Promise<ManagedState | { readonly newer: GrokMarker | undefined }> {
  const markerFile = await readGrokPrivateFile(paths.marker, 'marker', budget);
  if (markerFile === undefined) throw new Error('Grok private directory already exists');
  const markerKind = peekManagedFormat(markerFile.text);
  if (markerKind === 'newer') return { newer: undefined };
  if (markerKind === 'invalid') throw new Error('Grok marker invalid');
  const marker = parseGrokMarker(markerFile.text);
  if (isNewerAdapter(marker.adapterVersion, adapterVersion)) return { newer: marker };
  const ownershipFile = await readGrokPrivateFile(paths.ownership, 'ownership', budget);
  if (ownershipFile === undefined) throw new Error('Grok ownership missing');
  const ownershipKind = peekManagedFormat(ownershipFile.text);
  if (ownershipKind === 'newer') return { newer: marker };
  if (ownershipKind === 'invalid') throw new Error('Grok ownership invalid');
  const ownership = parseGrokOwnership(ownershipFile.text);
  if (ownership.installationId !== marker.installationId || ownership.endpoint !== marker.endpoint) {
    throw new Error('Grok ownership identity mismatch');
  }
  return { marker, markerFile, ownership, ownershipFile, config: await readGrokFile(paths.config, budget) };
}

export function requireCurrent(text: string, ownership: GrokOwnership): void {
  for (const leaf of ownership.leaves) {
    const current = tryReadLeaf(text, leaf.path);
    if (current === undefined || !equalGrokLeaf(current, leaf.written)) {
      throw new Error('Grok configuration modified: ' + leaf.path.join('.'));
    }
  }
}

export async function persistOwnership(
  lock: FileLock,
  paths: GrokPaths,
  ownership: GrokOwnership,
  expected: GrokFileSnapshot | undefined,
  budget: GrokDeadline,
): Promise<GrokFileSnapshot> {
  await replaceOwnedFile(lock, paths.ownership, encodeGrokOwnership(ownership), expected, budget);
  const saved = await readGrokPrivateFile(paths.ownership, 'ownership', budget);
  if (saved === undefined) throw new Error('Grok ownership missing');
  return saved;
}

export async function persistMarker(
  lock: FileLock,
  paths: GrokPaths,
  marker: GrokMarker,
  expected: GrokFileSnapshot | undefined,
  budget: GrokDeadline,
): Promise<GrokFileSnapshot> {
  await replaceOwnedFile(lock, paths.marker, encodeGrokMarker(marker), expected, budget);
  const saved = await readGrokPrivateFile(paths.marker, 'marker', budget);
  if (saved === undefined) throw new Error('Grok marker invalid');
  return saved;
}

export async function readRemovalJournal(
  paths: GrokPaths,
  budget: GrokDeadline,
): Promise<GrokFileSnapshot | undefined> {
  return readGrokPrivateFile(paths.removalJournal, 'removal journal', budget);
}

function isOwnedRemovalJournal(existingText: string, nextText: string): boolean {
  try {
    const existing = parseGrokOwnership(existingText);
    const next = parseGrokOwnership(nextText);
    if (!(isCompletedGrokRemoval(existing) || isBootstrapGrokJournal(existing))) return false;
    return existing.installationId === next.installationId && existing.endpoint === next.endpoint;
  } catch {
    return false;
  }
}

export async function persistRemovalJournal(
  lock: FileLock,
  paths: GrokPaths,
  text: string,
  budget: GrokDeadline,
): Promise<void> {
  const existing = await readRemovalJournal(paths, budget);
  if (existing !== undefined && !isOwnedRemovalJournal(existing.text, text)) {
    throw new Error('Grok removal journal already exists');
  }
  await replaceOwnedFile(lock, paths.removalJournal, text, existing, budget);
}

export async function clearRemovalJournal(lock: FileLock, paths: GrokPaths, budget: GrokDeadline): Promise<void> {
  const existing = await readRemovalJournal(paths, budget);
  if (existing === undefined) return;
  await lock.withOwnershipFence(async (assertOwnership) => {
    await unlinkGrokFile(paths.removalJournal, existing, budget, assertOwnership, 'removal journal');
  });
}

export async function clearOwnedRemovalJournal(lock: FileLock, paths: GrokPaths, budget: GrokDeadline): Promise<void> {
  const existing = await readRemovalJournal(paths, budget);
  if (existing === undefined) return;
  try {
    const ownership = parseGrokOwnership(existing.text);
    if (isCompletedGrokRemoval(ownership) || isBootstrapGrokJournal(ownership)) {
      await clearRemovalJournal(lock, paths, budget);
      return;
    }
  } catch {
    // Foreign or invalid leftover journals are not taken over.
  }
  throw new Error('Grok removal journal already exists');
}

export async function restoreOwnershipFromRemovalJournal(
  lock: FileLock,
  paths: GrokPaths,
  budget: GrokDeadline,
): Promise<GrokFileSnapshot | undefined> {
  const existing = await readGrokPrivateFile(paths.ownership, 'ownership', budget);
  if (existing !== undefined) return existing;
  const journal = await readRemovalJournal(paths, budget);
  if (journal === undefined) return undefined;
  await replaceOwnedFile(lock, paths.ownership, journal.text, undefined, budget);
  return readGrokPrivateFile(paths.ownership, 'ownership', budget);
}

export async function commitGrokEdit(
  lock: FileLock,
  paths: GrokPaths,
  operation: 'configure' | 'remove',
  edit: TomlEdit,
  ownership: GrokOwnership,
  config: GrokFileSnapshot | undefined,
  ownershipFile: GrokFileSnapshot,
  budget: GrokDeadline,
  testDeps?: GrokConfigureTestDeps,
): Promise<{ readonly ownership: GrokOwnership; readonly ownershipFile: GrokFileSnapshot }> {
  const pending: GrokOwnership = {
    format: 1,
    agent: 'grok',
    installationId: ownership.installationId,
    endpoint: ownership.endpoint,
    status: ownership.status,
    leaves: ownership.leaves,
    createdTables: ownership.createdTables,
    pending: {
      operation,
      changes: edit.changes,
      nextLeaves: edit.leaves,
      nextCreatedTables: edit.createdTables,
    },
    ...(ownership.revokeStatus === undefined ? {} : { revokeStatus: ownership.revokeStatus }),
  };
  let pendingFile = ownershipFile;
  if (encodeGrokOwnership(pending) !== ownershipFile.text) {
    pendingFile = await persistOwnership(lock, paths, pending, ownershipFile, budget);
  }
  await testDeps?.failpoint?.('ownership_pending');
  if (!(operation === 'remove' && config === undefined)) {
    await replaceOwnedFile(lock, paths.config, edit.text, config, budget, {
      beforeRename: testDeps?.beforeRename,
    });
    await testDeps?.failpoint?.('config');
  }
  const committed: GrokOwnership = {
    format: 1,
    agent: 'grok',
    installationId: ownership.installationId,
    endpoint: ownership.endpoint,
    status: ownership.status,
    leaves: edit.leaves,
    createdTables: edit.createdTables,
    ...(ownership.revokeStatus === undefined
      ? {}
      : {
          revokeStatus: ownership.revokeStatus,
          ...(ownership.cleanupComplete === true ? { cleanupComplete: true as const } : {}),
        }),
  };
  const committedFile = await persistOwnership(lock, paths, committed, pendingFile, budget);
  await testDeps?.failpoint?.('ownership_committed');
  return { ownership: committed, ownershipFile: committedFile };
}

import type { FileLock } from '@aio-proxy/core';

import {
  assertSafePrivateDir,
  assertSafeRoot,
  captureIdentity,
  createPrivateDir,
  grokPaths,
  inspectPath,
  isRecoverableBootstrapPrivateDir,
  readGrokFile,
  readGrokPrivateFile,
  removeGrokOwnedTemporaryFiles,
  removeMatchingDir,
  removeMatchingFile,
  type GrokFileIdentity,
  type GrokFileSnapshot,
  type GrokPaths,
} from './files';
import { grokAuthCommand } from './grok-command';
import {
  clearConsumedRemovalJournal,
  clearOwnedRemovalJournal,
  commitGrokEdit,
  configTextOrEmpty,
  createBudget,
  loadManaged,
  persistMarker,
  persistOwnership,
  replaceOwnedFile,
  requireCurrent,
  restoreOwnershipFromRemovalJournal,
  withGrokLock,
  type GrokConfigureTestDeps,
  type ManagedState,
} from './lifecycle';
import {
  adoptRecoveredOwnership,
  isBootstrapGrokJournal,
  isCanonicalLoopbackOrigin,
  isCompletedGrokRemoval,
  isIncompleteRebind,
  isNewerAdapter,
  parseGrokMarker,
  parseGrokOwnership,
  recoverGrokOwnership,
} from './ownership';
import { checkGrokPolicy } from './policy';
import { configureGrokToml, equalGrokLeaf } from './toml';
import type { GrokConfigureInput, GrokDeadline, GrokDeps, GrokMarker, GrokOwnership, TomlEdit } from './types';

export type { GrokConfigureTestDeps } from './lifecycle';

function hasConfigChanges(edit: TomlEdit): boolean {
  return edit.changes.some((change) => !equalGrokLeaf(change.before, change.after));
}

function prepareEdit(
  text: string,
  input: GrokConfigureInput,
  installationId: string,
  previous?: { readonly leaves: GrokOwnership['leaves']; readonly createdTables: GrokOwnership['createdTables'] },
): { readonly command: string; readonly edit: TomlEdit } {
  const command = grokAuthCommand(input.executable, installationId);
  return { command, edit: configureGrokToml(text, input.endpoint, command, previous) };
}

async function mustReadOwnership(paths: GrokPaths, budget: GrokDeadline): Promise<GrokFileSnapshot> {
  const saved = await readGrokPrivateFile(paths.ownership, 'ownership', budget);
  if (saved === undefined) throw new Error('Grok ownership missing');
  return saved;
}

async function configureExisting(
  lock: FileLock,
  paths: GrokPaths,
  input: GrokConfigureInput,
  deps: GrokDeps,
  budget: GrokDeadline,
  loaded: ManagedState,
  testDeps?: GrokConfigureTestDeps,
): Promise<{ readonly marker: GrokMarker; readonly status: 'installed' | 'updated' | 'newer' }> {
  if (loaded.marker.endpoint !== input.endpoint) throw new Error('Grok endpoint changed');
  const configText = configTextOrEmpty(loaded.config);
  const recovered = recoverGrokOwnership(configText, loaded.ownership);
  const adopted = adoptRecoveredOwnership(loaded.ownership, loaded.ownershipFile.text, recovered);
  let ownership = adopted.ownership;
  let ownershipFile = loaded.ownershipFile;
  if (adopted.persist) {
    ownershipFile = await persistOwnership(lock, paths, ownership, ownershipFile, budget);
  }
  if (recovered.conflicts.length > 0) {
    throw new Error('Grok configuration modified: ' + recovered.conflicts.join(', '));
  }
  if (ownership.status !== 'active') throw new Error('Grok installation is removing');
  requireCurrent(configText, ownership);
  const { command, edit } = prepareEdit(configText, input, loaded.marker.installationId, {
    leaves: ownership.leaves,
    createdTables: ownership.createdTables,
  });
  const visible = await deps.policy(input.root, budget);
  const conflicts = checkGrokPolicy(edit.text, input.endpoint, command, visible);
  if (conflicts.length > 0) throw new Error('Grok routing conflict: ' + conflicts.join(', '));
  const versionChanged = loaded.marker.adapterVersion !== input.adapterVersion;
  if (!hasConfigChanges(edit) && !versionChanged) {
    return { marker: loaded.marker, status: 'updated' };
  }
  let marker = loaded.marker;
  if (hasConfigChanges(edit)) {
    await commitGrokEdit(lock, paths, 'configure', edit, ownership, loaded.config, ownershipFile, budget, testDeps);
  }
  if (versionChanged) {
    marker = { ...marker, adapterVersion: input.adapterVersion };
    await persistMarker(lock, paths, marker, loaded.markerFile, budget);
    await testDeps?.failpoint?.('marker_version');
  }
  return { marker, status: 'updated' };
}

type ConfigureFirstReuse = {
  readonly ownership?: GrokFileSnapshot;
  readonly marker?: GrokFileSnapshot;
};

const resumeConfigureInstallationId = (
  reuse: ConfigureFirstReuse | undefined,
  endpoint: GrokConfigureInput['endpoint'],
  randomUUID: () => string,
): string => {
  if (reuse?.ownership === undefined) return randomUUID();
  try {
    const ownership = parseGrokOwnership(reuse.ownership.text);
    if (isBootstrapGrokJournal(ownership) && ownership.endpoint === endpoint) {
      return ownership.installationId;
    }
  } catch {
    // A foreign leftover ownership file is not a resume token.
  }
  return randomUUID();
};

async function configureFirst(
  lock: FileLock,
  paths: GrokPaths,
  input: GrokConfigureInput,
  deps: GrokDeps,
  budget: GrokDeadline,
  config: GrokFileSnapshot | undefined,
  testDeps?: GrokConfigureTestDeps,
  reuse?: ConfigureFirstReuse,
): Promise<{ readonly marker: GrokMarker; readonly status: 'installed' | 'updated' | 'newer' }> {
  const installationId = resumeConfigureInstallationId(reuse, input.endpoint, deps.randomUUID);
  const { command, edit } = prepareEdit(configTextOrEmpty(config), input, installationId);
  const visible = await deps.policy(input.root, budget);
  const conflicts = checkGrokPolicy(edit.text, input.endpoint, command, visible);
  if (conflicts.length > 0) throw new Error('Grok routing conflict: ' + conflicts.join(', '));
  const marker: GrokMarker = {
    format: 1,
    managedBy: 'aio-proxy',
    agent: 'grok',
    installationId,
    adapterVersion: input.adapterVersion,
    endpoint: input.endpoint,
  };
  const pending: GrokOwnership = {
    format: 1,
    agent: 'grok',
    installationId,
    endpoint: input.endpoint,
    status: 'active',
    leaves: [],
    createdTables: [],
    pending: {
      operation: 'configure',
      changes: edit.changes,
      nextLeaves: edit.leaves,
      nextCreatedTables: edit.createdTables,
    },
  };
  const created: GrokFileIdentity[] = [];
  let privateDir: GrokFileIdentity | undefined;
  let markerWritten = false;
  try {
    if (reuse === undefined) {
      const existing = await inspectPath(paths.privateDir, budget);
      if (existing === undefined) {
        privateDir = await createPrivateDir(paths.privateDir);
      } else {
        assertSafePrivateDir(existing);
        if (!(await isRecoverableBootstrapPrivateDir(paths.privateDir))) {
          throw new Error('Grok private directory already exists');
        }
        await removeGrokOwnedTemporaryFiles(paths);
        privateDir = { path: paths.privateDir, dev: existing.dev, ino: existing.ino };
      }
      await testDeps?.failpoint?.('private_dir');
    }
    await persistOwnership(lock, paths, pending, reuse?.ownership, budget);
    created.push(await captureIdentity(paths.ownership));
    await testDeps?.failpoint?.('ownership_pending');
    await persistMarker(lock, paths, marker, reuse?.marker, budget, testDeps);
    created.push(await captureIdentity(paths.marker));
    markerWritten = true;
    await testDeps?.failpoint?.('marker');
    await commitGrokEdit(
      lock,
      paths,
      'configure',
      edit,
      pending,
      config,
      await mustReadOwnership(paths, budget),
      budget,
      testDeps,
    );
    await clearConsumedRemovalJournal(lock, paths, budget);
    return { marker, status: 'installed' };
  } catch (error) {
    if (!markerWritten && (await inspectPath(paths.marker)) !== undefined) markerWritten = true;
    if (!markerWritten && reuse === undefined) {
      for (const identity of created.reverse()) await removeMatchingFile(identity);
      if (privateDir !== undefined) await removeMatchingDir(privateDir);
    }
    if (!markerWritten && reuse?.ownership !== undefined) {
      try {
        await replaceOwnedFile(
          lock,
          paths.ownership,
          reuse.ownership.text,
          await mustReadOwnership(paths, budget),
          budget,
        );
      } catch {
        // Best-effort restore of the pre-rebind ownership journal.
      }
    }
    throw error;
  }
}

async function configureGrokInternal(
  input: GrokConfigureInput,
  deps: GrokDeps,
  testDeps?: GrokConfigureTestDeps,
): Promise<{ readonly marker: GrokMarker; readonly status: 'installed' | 'updated' | 'newer' }> {
  if (!isCanonicalLoopbackOrigin(input.endpoint)) throw new Error('invalid endpoint');
  const budget = createBudget(deps.now);
  const paths = grokPaths(input.root);
  return withGrokLock(input.root, budget, async (lock) =>
    lock.withOwnership(async () => {
      budget.signal.throwIfAborted();
      const rootStat = await inspectPath(paths.root, budget);
      if (rootStat === undefined) throw new Error('Grok root is not a directory');
      assertSafeRoot(rootStat);
      const privateStat = await inspectPath(paths.privateDir, budget);
      if (privateStat === undefined) {
        await clearOwnedRemovalJournal(lock, paths, budget);
        return configureFirst(lock, paths, input, deps, budget, await readGrokFile(paths.config, budget), testDeps);
      }
      assertSafePrivateDir(privateStat);
      const markerFile = await readGrokPrivateFile(paths.marker, 'marker', budget);
      const ownershipFile =
        (await readGrokPrivateFile(paths.ownership, 'ownership', budget)) ??
        (await restoreOwnershipFromRemovalJournal(lock, paths, budget));
      if (markerFile === undefined) {
        if (ownershipFile !== undefined) {
          try {
            const ownership = parseGrokOwnership(ownershipFile.text);
            if (isCompletedGrokRemoval(ownership) || isBootstrapGrokJournal(ownership)) {
              return configureFirst(
                lock,
                paths,
                input,
                deps,
                budget,
                await readGrokFile(paths.config, budget),
                testDeps,
                {
                  ownership: ownershipFile,
                },
              );
            }
          } catch {
            // Foreign or invalid leftover ownership is not taken over.
          }
        }
        return configureFirst(lock, paths, input, deps, budget, await readGrokFile(paths.config, budget), testDeps);
      }
      if (ownershipFile !== undefined) {
        try {
          const ownership = parseGrokOwnership(ownershipFile.text);
          const marker = parseGrokMarker(markerFile.text);
          if (isIncompleteRebind(ownership, marker)) {
            if (isNewerAdapter(marker.adapterVersion, input.adapterVersion)) {
              return { marker, status: 'newer' };
            }
            return configureFirst(
              lock,
              paths,
              input,
              deps,
              budget,
              await readGrokFile(paths.config, budget),
              testDeps,
              {
                ownership: ownershipFile,
                marker: markerFile,
              },
            );
          }
        } catch {
          // loadManaged reports foreign or invalid leftovers.
        }
      }
      const loaded = await loadManaged(paths, input.adapterVersion, budget);
      if ('newer' in loaded) {
        if (loaded.newer === undefined) throw new Error('Grok configuration is newer');
        return { marker: loaded.newer, status: 'newer' };
      }
      if (isCompletedGrokRemoval(loaded.ownership)) {
        return configureFirst(lock, paths, input, deps, budget, await readGrokFile(paths.config, budget), testDeps, {
          ownership: loaded.ownershipFile,
          marker: loaded.markerFile,
        });
      }
      return configureExisting(lock, paths, input, deps, budget, loaded, testDeps);
    }),
  );
}

export async function configureGrok(
  input: GrokConfigureInput,
  deps: GrokDeps,
): Promise<{ readonly marker: GrokMarker; readonly status: 'installed' | 'updated' | 'newer' }> {
  return configureGrokInternal(input, deps);
}

export async function configureGrokForTest(
  input: GrokConfigureInput,
  deps: GrokDeps,
  testDeps: GrokConfigureTestDeps,
): Promise<{ readonly marker: GrokMarker; readonly status: 'installed' | 'updated' | 'newer' }> {
  return configureGrokInternal(input, deps, testDeps);
}

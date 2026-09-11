import { join } from 'node:path';

import { observeFileLockOwner } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import {
  assertSafePrivateDir,
  assertSafeRoot,
  grokPaths,
  inspectPath,
  isRecoverableBootstrapPrivateDir,
  readGrokCredentialText,
  readGrokFile,
  readGrokPrivateFile,
  unlinkGrokFile,
} from './files';
import {
  assertGrokRoutingSafe,
  configTextOrEmpty,
  loadManaged,
  persistOwnership,
  replaceOwnedFile,
  requireCurrent,
  tryReadLeaf,
  withGrokLock,
} from './lifecycle';
import {
  adoptRecoveredOwnership,
  isIncompleteRebind,
  isNewerAdapter,
  parseGrokMarker,
  parseGrokOwnership,
  peekManagedFormat,
  recoverGrokOwnership,
} from './ownership';
import { equalGrokLeaf } from './toml';
import type { GrokAuthObservation, GrokContext, GrokDeadline, GrokDeps, GrokInspection, GrokMarker } from './types';

export { configureGrok, configureGrokForTest, type GrokConfigureTestDeps } from './configure';
export { grokAuthCommand, loadGrokPolicy } from './grok-command';
export { removeGrok, removeGrokForTest, type GrokRemoveResult, type GrokRemoveTestDeps } from './remove';

const revisionSchema = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0);
const GrokObservationSchema = z
  .object({
    format: z.literal(1),
    agent: z.literal('grok'),
    installationId: z.uuid(),
    revision: revisionSchema,
    deliveredBy: z.uuid().optional(),
  })
  .passthrough();

const LOCK_WRITE_GRACE_MS = 250;

const isTemporaryLockObservation = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('temporary file lock observation failure');

const isMalformedLockObservation = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('temporary file lock observation failure (malformed)');

async function observeGrokLockOwner(root: string, budget: GrokDeadline): Promise<string | undefined> {
  const path = join(root, '.aio-proxy.lock');
  const started = Date.now();
  while (true) {
    budget.signal.throwIfAborted();
    try {
      return await observeFileLockOwner(path, budget);
    } catch (error) {
      if (!isTemporaryLockObservation(error)) throw error;
      const remaining = budget.deadline - Date.now();
      if (remaining <= 0) throw error;
      // acquireFileLock creates the lock file before writing the JSON record.
      if (isMalformedLockObservation(error) && Date.now() - started >= LOCK_WRITE_GRACE_MS) return undefined;
      await Bun.sleep(Math.min(50 + Math.floor(Math.random() * 25), remaining));
    }
  }
}

export async function readGrokObservation(
  root: string,
  installationId: string,
  budget: GrokDeadline,
): Promise<GrokAuthObservation> {
  budget.signal.throwIfAborted();
  const lockOwner = await observeGrokLockOwner(root, budget);
  budget.signal.throwIfAborted();
  const text = await readGrokCredentialText(root, budget);
  if (text === undefined) return lockOwner === undefined ? {} : { lockOwner };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Grok credential invalid');
  }
  if (!isPlainObject(raw)) throw new Error('Grok credential invalid');
  const parsed = GrokObservationSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Grok credential invalid');
  if (parsed.data.installationId !== installationId) throw new Error('Grok credential binding mismatch');
  return {
    revision: parsed.data.revision,
    ...(parsed.data.deliveredBy === undefined ? {} : { deliveredBy: parsed.data.deliveredBy }),
    ...(lockOwner === undefined ? {} : { lockOwner }),
  };
}

const absentInspection = (): GrokInspection => ({
  integrationKind: 'auth-command',
  integration: 'absent',
  configuration: 'missing',
  fields: [],
});
const conflictInspection = (marker?: GrokMarker): GrokInspection => ({
  integrationKind: 'auth-command',
  integration: 'conflict',
  ...(marker === undefined ? {} : { marker }),
  configuration: 'missing',
  fields: [],
});

async function inspectManagedRoot(root: string, adapterVersion: string): Promise<GrokInspection> {
  const paths = grokPaths(root);
  const rootStat = await inspectPath(paths.root);
  if (rootStat === undefined) return absentInspection();
  assertSafeRoot(rootStat);
  const privateStat = await inspectPath(paths.privateDir);
  if (privateStat === undefined) return absentInspection();
  assertSafePrivateDir(privateStat);
  const markerFile = await readGrokPrivateFile(paths.marker, 'marker');
  if (markerFile === undefined) {
    if (await isRecoverableBootstrapPrivateDir(paths.privateDir)) return absentInspection();
    return conflictInspection();
  }
  const markerKind = peekManagedFormat(markerFile.text);
  if (markerKind === 'newer') {
    return { integrationKind: 'auth-command', integration: 'newer', configuration: 'missing', fields: [] };
  }
  if (markerKind === 'invalid') return conflictInspection();
  const marker = parseGrokMarker(markerFile.text);
  if (isNewerAdapter(marker.adapterVersion, adapterVersion)) {
    return { integrationKind: 'auth-command', integration: 'newer', marker, configuration: 'current', fields: [] };
  }
  const ownershipFile = await readGrokPrivateFile(paths.ownership, 'ownership');
  if (ownershipFile === undefined) {
    return {
      integrationKind: 'auth-command',
      integration: 'managed',
      marker,
      configuration: 'recovery_required',
      fields: [],
    };
  }
  const ownershipKind = peekManagedFormat(ownershipFile.text);
  if (ownershipKind === 'newer') {
    return { integrationKind: 'auth-command', integration: 'newer', marker, configuration: 'missing', fields: [] };
  }
  if (ownershipKind === 'invalid') return conflictInspection(marker);
  const ownership = parseGrokOwnership(ownershipFile.text);
  if (isIncompleteRebind(ownership, marker)) {
    return {
      integrationKind: 'auth-command',
      integration: 'managed',
      marker,
      configuration: 'recovery_required',
      fields: [],
    };
  }
  if (ownership.installationId !== marker.installationId || ownership.endpoint !== marker.endpoint) {
    return conflictInspection(marker);
  }
  if (ownership.pending !== undefined) {
    const config = await readGrokFile(paths.config);
    const recovered = recoverGrokOwnership(configTextOrEmpty(config), ownership);
    const pending = recovered.ownership.pending ?? ownership.pending;
    return {
      integrationKind: 'auth-command',
      integration: 'managed',
      marker,
      configuration: 'recovery_required',
      fields:
        recovered.conflicts.length > 0 ? recovered.conflicts : pending.changes.map((change) => change.path.join('.')),
    };
  }
  if (ownership.status === 'removing') {
    return {
      integrationKind: 'auth-command',
      integration: 'managed',
      marker,
      configuration: 'recovery_required',
      fields: [],
    };
  }
  const config = await readGrokFile(paths.config);
  if (config === undefined) {
    return { integrationKind: 'auth-command', integration: 'managed', marker, configuration: 'missing', fields: [] };
  }
  const fields: string[] = [];
  for (const leaf of ownership.leaves) {
    const current = tryReadLeaf(config.text, leaf.path);
    if (current === undefined || !equalGrokLeaf(current, leaf.written)) fields.push(leaf.path.join('.'));
  }
  return {
    integrationKind: 'auth-command',
    integration: 'managed',
    marker,
    configuration: fields.length > 0 ? 'modified' : 'current',
    fields,
  };
}

export async function inspectGrok(root: string, adapterVersion: string): Promise<GrokInspection> {
  try {
    return await inspectManagedRoot(root, adapterVersion);
  } catch {
    return conflictInspection();
  }
}

export type GrokInstallationTestHook = {
  readonly afterAction?: () => Promise<void>;
  readonly beforeReadyCredentialRename?: () => Promise<void>;
  readonly failDeliveredByWrite?: boolean;
};

let grokInstallationTestHook: GrokInstallationTestHook | undefined;

export function setGrokInstallationTestHookForTest(hook?: GrokInstallationTestHook): void {
  grokInstallationTestHook = hook;
}

function readyCredentialWithoutDelivery(value: unknown): boolean {
  return isPlainObject(value) && value['status'] === 'ready' && value['deliveredBy'] === undefined;
}

function deliveredByWrite(value: unknown): boolean {
  return isPlainObject(value) && typeof value['deliveredBy'] === 'string';
}

export async function withGrokInstallation<T>(
  input: {
    readonly root: string;
    readonly installationId: string;
    readonly adapterVersion: string;
    readonly budget: GrokDeadline;
    readonly policy: GrokDeps['policy'];
  },
  action: (context: GrokContext) => Promise<T>,
): Promise<T> {
  const paths = grokPaths(input.root);
  return withGrokLock(input.root, input.budget, async (lock) =>
    lock.withOwnership(async (assertOwnership) => {
      input.budget.signal.throwIfAborted();
      const rootStat = await inspectPath(paths.root);
      if (rootStat === undefined) throw new Error('Grok root is not a directory');
      assertSafeRoot(rootStat);
      const privateStat = await inspectPath(paths.privateDir);
      if (privateStat === undefined) throw new Error('Grok installation missing');
      assertSafePrivateDir(privateStat);
      const loaded = await loadManaged(paths, input.adapterVersion, input.budget);
      if ('newer' in loaded) throw new Error('Grok configuration is newer');
      if (loaded.marker.installationId !== input.installationId) throw new Error('installation id mismatch');
      const recovered = recoverGrokOwnership(configTextOrEmpty(loaded.config), loaded.ownership);
      const adopted = adoptRecoveredOwnership(loaded.ownership, loaded.ownershipFile.text, recovered);
      const ownership = adopted.ownership;
      if (adopted.persist) {
        await persistOwnership(lock, paths, ownership, loaded.ownershipFile, input.budget);
      }
      if (recovered.conflicts.length > 0) {
        throw new Error('Grok configuration modified: ' + recovered.conflicts.join(', '));
      }
      if (ownership.status !== 'active') throw new Error('Grok installation is removing');
      if (ownership.pending !== undefined) throw new Error('Grok configuration requires recovery');
      const config = await readGrokFile(paths.config, input.budget);
      if (config === undefined) throw new Error('Grok configuration missing');
      requireCurrent(config.text, ownership);
      await assertGrokRoutingSafe(input.root, loaded.marker, ownership, input.policy, input.budget);
      const context: GrokContext = {
        marker: loaded.marker,
        root: input.root,
        budget: input.budget,
        assertOwnership,
        lockOwner: lock.owner,
        assertRoutingSafe: () =>
          assertGrokRoutingSafe(input.root, loaded.marker, ownership, input.policy, input.budget),
        async readCredential() {
          await assertOwnership();
          const snapshot = await readGrokPrivateFile(paths.credential, 'credential', input.budget);
          if (snapshot === undefined || snapshot.text.trim() === '') return undefined;
          try {
            return JSON.parse(snapshot.text) as unknown;
          } catch {
            throw new Error('Grok credential invalid');
          }
        },
        async writeCredential(value: unknown) {
          const encoded = JSON.stringify(value);
          if (encoded === undefined) throw new Error('Grok credential invalid');
          if (grokInstallationTestHook?.failDeliveredByWrite === true && deliveredByWrite(value)) {
            throw new Error('Grok completion mark write failed');
          }
          const expected = await readGrokPrivateFile(paths.credential, 'credential', input.budget);
          await replaceOwnedFile(lock, paths.credential, `${encoded}\n`, expected, input.budget, {
            beforeRename: async () => {
              if (readyCredentialWithoutDelivery(value)) {
                await grokInstallationTestHook?.beforeReadyCredentialRename?.();
              }
            },
          });
        },
        async clearCredential() {
          const expected = await readGrokPrivateFile(paths.credential, 'credential', input.budget);
          await lock.withOwnershipFence(async (assertFenced) => {
            await unlinkGrokFile(paths.credential, expected, input.budget, assertFenced);
          });
        },
      };
      const result = await action(context);
      await grokInstallationTestHook?.afterAction?.();
      return result;
    }),
  );
}

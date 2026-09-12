import { isPlainObject } from 'es-toolkit/predicate';

import {
  codexProviderEdits,
  editCodexDocument,
  hasCodexTable,
  readCodexDocument,
  readManagedField,
  type FieldEdit,
} from '../config-document';
import type {
  CodexLocation,
  CodexAuthConfig,
  CodexMarker,
  ConfigCommit,
  ConfigRemoval,
  OwnedField,
} from '../contracts';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import { changedFields, equalSlot } from './inspect';
import {
  clearJournal,
  fingerprint,
  isLiveJournal,
  readJournal,
  releaseJournalOwner,
  startJournal,
  updateJournal,
} from './journal';
import { deleteMarker, readMarker, validateMarker, writeMarker } from './marker';
import {
  assertNoSymlinkParents,
  chmodChecked,
  ensureManagedRoot,
  inspectDirectory,
  readRegularFile,
  syncParent,
  writeTomlAtomically,
} from './storage';

const providerFields = ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'experimental_bearer_token'] as const;
const commandFields = ['command', 'args', 'timeout_ms', 'refresh_interval_ms'] as const;
const authenticationFields = new Set(['env_key', 'aws', 'headers', 'header', 'api_key']);
const operations = new Map<string, Promise<void>>();

const runExclusive = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const prior = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  operations.set(key, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (operations.get(key) === current) operations.delete(key);
  }
};

const withInstallationLease = <T>(
  location: CodexLocation,
  lease: CodexLease | undefined,
  operation: (owned: CodexLease) => Promise<T>,
): Promise<T> => {
  if (lease !== undefined) return lease.withOwnership(async () => operation(lease));
  return withCodexInstallation(location, AbortSignal.timeout(15_000), operation);
};

const providerPath = (providerId: string, field: string): readonly string[] => ['model_providers', providerId, field];
const ownedPaths = (providerId: string): readonly (readonly string[])[] => [
  ['model_provider'],
  ...providerFields.map((field) => providerPath(providerId, field)),
];

const asTable = (value: unknown): Record<string, unknown> | undefined => (isPlainObject(value) ? value : undefined);

const markerFields = (marker: CodexMarker): readonly string[][] => marker.fields.map((field) => [...field.path]);

const readText = async (location: CodexLocation) => readRegularFile(location.configPath);

const applyEditsSequentially = (text: string, edits: readonly FieldEdit[]): string =>
  edits.reduce((current, edit) => editCodexDocument(current, [edit]), text);

function providerObject(text: string, providerId: string): Record<string, unknown> | undefined {
  const providers = asTable(asTable(Bun.TOML.parse(text))?.['model_providers']);
  return providers === undefined ? undefined : asTable(providers[providerId]);
}

function removeCreatedProvider(text: string, marker: CodexMarker): string {
  if (!marker.createdTables.some((path) => path.length === 2 && path[0] === 'model_providers')) return text;
  const provider = providerObject(text, marker.providerId);
  if (provider === undefined || Object.keys(provider).length > 0) return text;
  return editCodexDocument(text, [{ path: ['model_providers', marker.providerId], next: { present: false } }]);
}

function removeCreatedTables(text: string, marker: CodexMarker): string {
  let result = text;
  for (const path of [...marker.createdTables].sort((left, right) => right.length - left.length)) {
    if (path.length === 2) {
      result = removeCreatedProvider(result, marker);
      continue;
    }
    const providerValue = asTable(asTable(Bun.TOML.parse(result))?.['model_providers'])?.[marker.providerId];
    const auth = asTable(asTable(providerValue)?.['auth']);
    if (auth !== undefined && Object.keys(auth).length === 0)
      result = editCodexDocument(result, [{ path, next: { present: false } }]);
  }
  return result;
}

function restoreOwnedFields(text: string, marker: CodexMarker, edits: readonly FieldEdit[]): string {
  const restored = applyEditsSequentially(text, edits);
  return removeCreatedTables(restored, marker);
}

async function recoverPending(location: CodexLocation, assertOwned?: () => Promise<void>): Promise<void> {
  await ensureManagedRoot(location);
  const pending = await readJournal(location);
  if (pending === undefined) return;
  if (await isLiveJournal(pending)) throw new Error('A live Codex configuration operation is pending');
  const current = await readText(location);
  const currentFingerprint = current === undefined ? undefined : fingerprint(current.text);
  const beforeMatches =
    currentFingerprint === pending.beforeFingerprint && pending.originalExists === (current !== undefined);
  const afterMatches = currentFingerprint === pending.afterFingerprint;
  if (pending.stage === 'prepared' && beforeMatches) {
    await assertOwned?.();
    await clearJournal(location);
    return;
  }
  if (afterMatches) {
    await assertOwned?.();
    if (pending.operation === 'remove') await deleteMarker(location);
    else await writeMarker(location, pending.targetMarker);
    await assertOwned?.();
    await clearJournal(location);
    return;
  }
  if (pending.stage === 'config-written' && beforeMatches) {
    await assertOwned?.();
    await clearJournal(location);
    return;
  }
  throw new Error('Codex configuration operation has an unknown recovery state; manual review is required');
}

export async function recoverCodexConfigOperation(
  location: CodexLocation,
  confirmRecovery?: () => Promise<boolean>,
  lease?: CodexLease,
): Promise<'none' | 'recovered' | 'declined'> {
  return withInstallationLease(location, lease, async (ownedLease) =>
    runExclusive(location.markerPath, async () => {
      await assertNoSymlinkParents(location.home);
      if ((await inspectDirectory(location.managedRoot)) === undefined) return 'none';
      const pending = await readJournal(location);
      if (pending === undefined) return 'none';
      if (await isLiveJournal(pending)) throw new Error('A live Codex configuration operation is pending');
      if (confirmRecovery !== undefined && !(await confirmRecovery())) return 'declined';
      await ensureManagedRoot(location);
      await ownedLease.withOwnershipFence((assertOwned) => recoverPending(location, assertOwned));
      return 'recovered';
    }),
  );
}

function findAuthenticationConflict(
  text: string,
  providerId: string,
  allowManagedCommandFields = false,
): string | undefined {
  try {
    const provider = asTable(asTable(Bun.TOML.parse(text))?.['model_providers'])?.[providerId];
    const table = asTable(provider);
    if (table === undefined) return undefined;
    for (const [key, value] of Object.entries(table)) {
      if (key === 'auth') {
        const auth = asTable(value);
        if (auth === undefined) return `model_providers.${providerId}.auth`;
        for (const authKey of Object.keys(auth)) {
          if (!allowManagedCommandFields || !commandFields.includes(authKey as (typeof commandFields)[number]))
            return `model_providers.${providerId}.auth.${authKey}`;
        }
        continue;
      }
      if (authenticationFields.has(key) || key.startsWith('header')) return `model_providers.${providerId}.${key}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function markerFor(
  location: CodexLocation,
  providerId: string,
  fields: readonly OwnedField[],
  createdTables: readonly (readonly string[])[],
  auth: CodexAuthConfig,
): CodexMarker {
  return auth.mode === 'command'
    ? {
        format: 2,
        managedBy: 'aio-proxy',
        configPath: location.configPath,
        providerId,
        fields,
        createdTables,
        authMode: 'command',
        installationId: auth.installationId,
      }
    : {
        format: 2,
        managedBy: 'aio-proxy',
        configPath: location.configPath,
        providerId,
        fields,
        createdTables,
        authMode: 'keep-chatgpt',
      };
}

async function completeOperation(
  location: CodexLocation,
  journal: Parameters<typeof startJournal>[1],
  original: Awaited<ReturnType<typeof readText>>,
  nextText: string,
  marker: CodexMarker | undefined,
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnershipFence(async (assertOwned) => {
    const ownedJournal = await startJournal(location, journal);
    try {
      await assertOwned();
      await writeTomlAtomically(location, original, nextText);
      await updateJournal(location, { ...ownedJournal, stage: 'config-written' });
      await assertOwned();
      if (marker === undefined) await deleteMarker(location);
      else await writeMarker(location, marker);
      await updateJournal(location, { ...ownedJournal, stage: 'marker-written' });
      await clearJournal(location);
      await syncParent(location.markerPath);
    } catch (error) {
      await releaseJournalOwner(location, ownedJournal).catch(() => undefined);
      throw error;
    }
  });
}

function makeFields(text: string, edits: readonly FieldEdit[], prior?: CodexMarker): OwnedField[] {
  return edits.map((edit) => ({
    path: edit.path,
    before:
      prior?.fields.find((field) => field.path.join('\u0000') === edit.path.join('\u0000'))?.before ??
      readManagedField(text, edit.path),
    applied: edit.next,
  }));
}

export async function configureCodexConfig(
  input: {
    readonly location: CodexLocation;
    readonly providerId: string;
    readonly baseUrl: string;
    readonly auth: CodexAuthConfig;
    readonly validateOnly?: boolean;
  },
  lease?: CodexLease,
): Promise<ConfigCommit> {
  return withInstallationLease(input.location, lease, async (ownedLease) =>
    runExclusive(input.location.markerPath, async () => {
      const { location, providerId, baseUrl, auth } = input;
      await ownedLease.withOwnershipFence((assertOwned) => recoverPending(location, assertOwned));
      const current = await readText(location);
      const text = current?.text ?? '';
      const document =
        current === undefined ? { activeProviderId: '', providerIds: [] as string[] } : readCodexDocument(text);
      const marker = await readMarker(location);
      const authConflict = findAuthenticationConflict(
        text,
        providerId,
        marker?.providerId === providerId && marker.format === 2 && marker.authMode === 'command',
      );
      if (authConflict !== undefined)
        throw new Error(`Codex provider contains user authentication field: ${authConflict}`);
      if (marker !== undefined && marker.providerId !== providerId) {
        if (document.providerIds.includes(providerId)) {
          throw new Error(`Codex provider ${providerId} is occupied and is not managed by aio-proxy`);
        }
        const oldAuthConflict = findAuthenticationConflict(
          text,
          marker.providerId,
          marker.format === 2 && marker.authMode === 'command',
        );
        if (oldAuthConflict !== undefined)
          throw new Error(`Codex provider contains user authentication field: ${oldAuthConflict}`);
      }
      let workingText = text;
      let createdTables: readonly (readonly string[])[] = [];
      if (marker !== undefined && marker.providerId !== providerId) {
        const drift = changedFields(marker, text);
        if (drift.length > 0)
          throw new Error(`Codex managed fields changed: ${drift.map((path) => path.join('.')).join(', ')}`);
        const cleanup = marker.fields.map((field) => ({ path: field.path, next: field.before }));
        workingText = restoreOwnedFields(text, marker, cleanup);
      } else if (marker === undefined && document.providerIds.includes(providerId)) {
        throw new Error(`Codex provider ${providerId} is not managed by aio-proxy`);
      } else if (marker !== undefined) {
        const drift = changedFields(marker, text);
        if (drift.length > 0)
          throw new Error(`Codex managed fields changed: ${drift.map((path) => path.join('.')).join(', ')}`);
      }
      const edits = codexProviderEdits(providerId, baseUrl, auth);
      const editedText = editCodexDocument(workingText, edits);
      const nextText = marker?.providerId === providerId ? removeCreatedTables(editedText, marker) : editedText;
      const fields = makeFields(workingText, edits, marker?.providerId === providerId ? marker : undefined);
      if (marker?.providerId === providerId) createdTables = marker.createdTables;
      else if (!document.providerIds.includes(providerId)) createdTables = [['model_providers', providerId]];
      const authPath = ['model_providers', providerId, 'auth'] as const;
      const hadAuthTable = hasCodexTable(text, authPath);
      if (
        auth.mode === 'command' &&
        !hadAuthTable &&
        !createdTables.some((path) => path.join('\u0000') === authPath.join('\u0000'))
      )
        createdTables = [...createdTables, authPath];
      const nextMarker = markerFor(location, providerId, fields, createdTables, auth);
      validateMarker(nextMarker, location);
      if (input.validateOnly) return { status: 'unchanged', providerId };
      if (nextText === text && marker?.providerId === providerId && changedFields(marker, text).length === 0) {
        await chmodChecked(location.configPath, 0o600);
        await chmodChecked(location.markerPath, 0o600);
        return { status: 'unchanged', providerId };
      }
      await completeOperation(
        location,
        {
          operation: 'configure',
          originalExists: current !== undefined,
          beforeFingerprint: current === undefined ? undefined : fingerprint(text),
          afterFingerprint: fingerprint(nextText),
          oldMarker: marker,
          targetMarker: nextMarker,
          stage: 'prepared',
        },
        current,
        nextText,
        nextMarker,
        ownedLease,
      );
      await chmodChecked(location.configPath, 0o600);
      return { status: 'configured', providerId };
    }),
  );
}

export function validateCodexConfig(
  input: Parameters<typeof configureCodexConfig>[0],
  lease?: CodexLease,
): Promise<ConfigCommit> {
  return configureCodexConfig({ ...input, validateOnly: true }, lease);
}

export async function removeCodexConfig(location: CodexLocation, lease?: CodexLease): Promise<ConfigRemoval> {
  return withInstallationLease(location, lease, async (ownedLease) =>
    runExclusive(location.markerPath, async () => {
      await ownedLease.withOwnershipFence((assertOwned) => recoverPending(location, assertOwned));
      const marker = await readMarker(location);
      if (marker === undefined) return { status: 'absent', preservedPaths: [] };
      const current = await readText(location);
      if (current === undefined) {
        await ownedLease.withOwnershipFence(async (assertOwned) => {
          const ownedJournal = await startJournal(location, {
            operation: 'remove',
            originalExists: false,
            afterFingerprint: undefined,
            oldMarker: marker,
            stage: 'prepared',
          });
          try {
            await assertOwned();
            await deleteMarker(location);
            await updateJournal(location, {
              operation: 'remove',
              originalExists: false,
              afterFingerprint: undefined,
              oldMarker: marker,
              owner: ownedJournal.owner,
              stage: 'marker-written',
            });
            await clearJournal(location);
          } catch (error) {
            await releaseJournalOwner(location, ownedJournal).catch(() => undefined);
            throw error;
          }
        });
        return { status: 'absent', preservedPaths: [] };
      }
      const restoreEdits: FieldEdit[] = [];
      const preservedPaths: readonly (readonly string[])[] = marker.fields.flatMap((field) => {
        const now = readManagedField(current.text, field.path);
        if (equalSlot(now, field.applied)) {
          restoreEdits.push({ path: field.path, next: field.before });
          return [];
        }
        return [field.path];
      });
      const nextText =
        restoreEdits.length === 0 ? current.text : restoreOwnedFields(current.text, marker, restoreEdits);
      await completeOperation(
        location,
        {
          operation: 'remove',
          originalExists: true,
          beforeFingerprint: fingerprint(current.text),
          afterFingerprint: fingerprint(nextText),
          oldMarker: marker,
          stage: 'prepared',
        },
        current,
        nextText,
        undefined,
        ownedLease,
      );
      return { status: preservedPaths.length === 0 ? 'removed' : 'partial', preservedPaths };
    }),
  );
}

export { markerFields, ownedPaths };

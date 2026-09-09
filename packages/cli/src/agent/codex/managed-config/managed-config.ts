import {
  codexProviderEdits,
  editCodexDocument,
  readCodexDocument,
  readManagedField,
  type FieldEdit,
  type ValueSlot,
} from '../config-document';
import type {
  CodexLocation,
  CodexMarker,
  ConfigCommit,
  ConfigInspection,
  ConfigRemoval,
  OwnedField,
} from '../contracts';
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
import { chmodChecked, ensureManagedRoot, readRegularFile, syncParent, writeTomlAtomically } from './storage';

const providerFields = ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'experimental_bearer_token'] as const;
const authenticationFields = new Set(['env_key', 'auth', 'aws', 'headers', 'header', 'api_key']);
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

const equalSlot = (left: ValueSlot, right: ValueSlot): boolean =>
  left.present === right.present && (!left.present || (right.present && left.value === right.value));

const providerPath = (providerId: string, field: string): readonly string[] => ['model_providers', providerId, field];
const ownedPaths = (providerId: string): readonly (readonly string[])[] => [
  ['model_provider'],
  ...providerFields.map((field) => providerPath(providerId, field)),
];

const markerFields = (marker: CodexMarker): readonly string[][] => marker.fields.map((field) => [...field.path]);

const readText = async (location: CodexLocation) => readRegularFile(location.configPath);

const applyEditsSequentially = (text: string, edits: readonly FieldEdit[]): string =>
  edits.reduce((current, edit) => editCodexDocument(current, [edit]), text);

function providerObject(text: string, providerId: string): Record<string, unknown> | undefined {
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  const providers = parsed['model_providers'];
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;
  const provider = (providers as Record<string, unknown>)[providerId];
  return provider && typeof provider === 'object' && !Array.isArray(provider)
    ? (provider as Record<string, unknown>)
    : undefined;
}

function removeCreatedProvider(text: string, marker: CodexMarker): string {
  if (!marker.createdTables.some((path) => path.length === 2 && path[0] === 'model_providers')) return text;
  const provider = providerObject(text, marker.providerId);
  if (provider === undefined || Object.keys(provider).length > 0) return text;
  return editCodexDocument(text, [{ path: ['model_providers', marker.providerId], next: { present: false } }]);
}

function restoreOwnedFields(text: string, marker: CodexMarker, edits: readonly FieldEdit[]): string {
  const restored = applyEditsSequentially(text, edits);
  return removeCreatedProvider(restored, marker);
}

async function recoverPending(location: CodexLocation): Promise<void> {
  await ensureManagedRoot(location);
  const pending = await readJournal(location);
  if (pending === undefined) return;
  if (isLiveJournal(pending)) throw new Error('A live Codex configuration operation is pending');
  const current = await readText(location);
  const currentFingerprint = current === undefined ? undefined : fingerprint(current.text);
  const beforeMatches =
    currentFingerprint === pending.beforeFingerprint && pending.originalExists === (current !== undefined);
  const afterMatches = currentFingerprint === pending.afterFingerprint;
  if (pending.stage === 'prepared' && beforeMatches) {
    await clearJournal(location);
    return;
  }
  if (afterMatches) {
    if (pending.targetMarker === undefined) await deleteMarker(location);
    else await writeMarker(location, pending.targetMarker);
    await clearJournal(location);
    return;
  }
  if (pending.stage === 'config-written' && beforeMatches) {
    await clearJournal(location);
    return;
  }
  throw new Error('Codex configuration operation has an unknown recovery state; manual review is required');
}

export async function recoverCodexConfigOperation(
  location: CodexLocation,
  confirmRecovery?: () => Promise<boolean>,
): Promise<'none' | 'recovered' | 'declined'> {
  return runExclusive(location.markerPath, async () => {
    await ensureManagedRoot(location);
    const pending = await readJournal(location);
    if (pending === undefined) return 'none';
    if (isLiveJournal(pending)) throw new Error('A live Codex configuration operation is pending');
    if (confirmRecovery !== undefined && !(await confirmRecovery())) return 'declined';
    await recoverPending(location);
    return 'recovered';
  });
}

async function checkCodexInstalled(): Promise<void> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(['codex', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw new Error('Codex installation is missing');
  }
  const output = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
  const exit = await child.exited;
  if (exit !== 0 || !/^codex-cli\s+\d+\.\d+\.\d+\b/m.test(output)) throw new Error('Codex installation is missing');
}

function findAuthenticationConflict(text: string, providerId: string): string | undefined {
  try {
    const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
    const providers = parsed['model_providers'];
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;
    const provider = (providers as Record<string, unknown>)[providerId];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return undefined;
    for (const key of Object.keys(provider as Record<string, unknown>)) {
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
): CodexMarker {
  return { format: 1, managedBy: 'aio-proxy', configPath: location.configPath, providerId, fields, createdTables };
}

async function completeOperation(
  location: CodexLocation,
  journal: Parameters<typeof startJournal>[1],
  original: Awaited<ReturnType<typeof readText>>,
  nextText: string,
  marker: CodexMarker | undefined,
): Promise<void> {
  const ownedJournal = await startJournal(location, journal);
  try {
    await writeTomlAtomically(location, original, nextText);
    await updateJournal(location, { ...ownedJournal, stage: 'config-written' });
    if (marker === undefined) await deleteMarker(location);
    else await writeMarker(location, marker);
    await updateJournal(location, { ...ownedJournal, stage: 'marker-written' });
    await clearJournal(location);
    await syncParent(location.markerPath);
  } catch (error) {
    await releaseJournalOwner(location, ownedJournal).catch(() => undefined);
    throw error;
  }
}

function changedFields(marker: CodexMarker, text: string): readonly (readonly string[])[] {
  return marker.fields.flatMap((field) =>
    equalSlot(readManagedField(text, field.path), field.applied) ? [] : [field.path],
  );
}

function makeFields(text: string, providerId: string, edits: readonly FieldEdit[], prior?: CodexMarker): OwnedField[] {
  return edits.map((edit) => ({
    path: edit.path,
    before:
      prior?.fields.find((field) => field.path.join('\u0000') === edit.path.join('\u0000'))?.before ??
      readManagedField(text, edit.path),
    applied: edit.next,
  }));
}

export async function inspectCodexConfig(location: CodexLocation): Promise<ConfigInspection> {
  const current = await readText(location);
  if (current === undefined) return { status: 'absent', activeProviderId: '', changedPaths: [] };
  const document = readCodexDocument(current.text);
  let marker: CodexMarker | undefined;
  try {
    marker = await readMarker(location);
  } catch {
    return { status: 'conflict', activeProviderId: document.activeProviderId, changedPaths: [] };
  }
  if (marker === undefined) return { status: 'absent', activeProviderId: document.activeProviderId, changedPaths: [] };
  const changedPaths = changedFields(marker, current.text);
  const base = readManagedField(current.text, providerPath(marker.providerId, 'base_url'));
  return {
    status: changedPaths.length === 0 ? 'managed' : 'modified',
    providerId: marker.providerId,
    activeProviderId: document.activeProviderId,
    baseUrl: base.present && typeof base.value === 'string' ? base.value : undefined,
    changedPaths,
  };
}

export async function configureCodexConfig(input: {
  readonly location: CodexLocation;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly token: string;
}): Promise<ConfigCommit> {
  await checkCodexInstalled();
  return runExclusive(input.location.markerPath, async () => {
    const { location, providerId, baseUrl, token } = input;
    await recoverPending(location);
    const current = await readText(location);
    const text = current?.text ?? '';
    const document =
      current === undefined ? { activeProviderId: '', providerIds: [] as string[] } : readCodexDocument(text);
    const marker = await readMarker(location);
    const authConflict = findAuthenticationConflict(text, providerId);
    if (authConflict !== undefined)
      throw new Error(`Codex provider contains user authentication field: ${authConflict}`);
    if (marker !== undefined && marker.providerId !== providerId) {
      if (document.providerIds.includes(providerId)) {
        throw new Error(`Codex provider ${providerId} is occupied and is not managed by aio-proxy`);
      }
      const oldAuthConflict = findAuthenticationConflict(text, marker.providerId);
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
    const edits = codexProviderEdits(providerId, baseUrl, token);
    const nextText = editCodexDocument(workingText, edits);
    const fields = makeFields(text, providerId, edits, marker?.providerId === providerId ? marker : undefined);
    if (marker?.providerId === providerId) createdTables = marker.createdTables;
    else if (!document.providerIds.includes(providerId)) createdTables = [['model_providers', providerId]];
    const nextMarker = markerFor(location, providerId, fields, createdTables);
    validateMarker(nextMarker, location);
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
    );
    await chmodChecked(location.configPath, 0o600);
    return { status: 'configured', providerId };
  });
}

export async function removeCodexConfig(location: CodexLocation): Promise<ConfigRemoval> {
  return runExclusive(location.markerPath, async () => {
    await recoverPending(location);
    const marker = await readMarker(location);
    if (marker === undefined) return { status: 'absent', preservedPaths: [] };
    const current = await readText(location);
    if (current === undefined) {
      const ownedJournal = await startJournal(location, {
        operation: 'remove',
        originalExists: false,
        afterFingerprint: undefined,
        oldMarker: marker,
        stage: 'prepared',
      });
      try {
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
    const nextText = restoreEdits.length === 0 ? current.text : restoreOwnedFields(current.text, marker, restoreEdits);
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
    );
    return { status: preservedPaths.length === 0 ? 'removed' : 'partial', preservedPaths };
  });
}

export { markerFields, ownedPaths };

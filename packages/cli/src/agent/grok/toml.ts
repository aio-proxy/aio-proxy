import { editTomlFields, inspectTomlPaths, readTomlField, type TomlFieldEdit } from '../toml-document';
import type { FieldChange, GrokPath, LeafValue, OwnedLeaf, TomlEdit } from './types';

export type { FieldChange, GrokPath, LeafValue, OwnedLeaf, TomlEdit } from './types';

const SYNTAX = { tomlVersion: '1.0' as const };
const SCALAR_TYPE_ERROR = 'TOML field must be a string or boolean';
const AUTH_TABLE = ['auth'] as const;
const GROK_COM_TABLE = ['grok_com_config'] as const;

type Inspected = ReturnType<typeof inspectTomlPaths>;
type AuthKey = 'auth_provider_command' | 'auth_provider_label';

const sameGrokPath = (left: GrokPath, right: GrokPath): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const pathKey = (path: GrokPath): string => JSON.stringify(path);

const hasPath = (inspected: Inspected, path: GrokPath): boolean =>
  inspected.fieldPaths.some((candidate) => sameGrokPath(candidate, path)) ||
  inspected.tablePaths.some((candidate) => sameGrokPath(candidate, path));

const hasTable = (inspected: Inspected, path: GrokPath): boolean =>
  inspected.tablePaths.some((candidate) => sameGrokPath(candidate, path));

const isUnsupportedManagedValue = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('unsupported_managed_value');

const desiredValues = (endpoint: string, command: string) => ({
  endpoints: {
    models_base_url: `${endpoint}/v1`,
    models_list_url: `${endpoint}/v1/models`,
    cli_chat_proxy_base_url: endpoint,
    xai_api_base_url: `${endpoint}/v1`,
    managed_config_url: `${endpoint}/__grok_unavailable/managed-config`,
  },
  auth: { auth_provider_command: command, auth_provider_label: 'AIO Proxy' },
});

function resolveCatalogPath(inspected: Inspected): GrokPath {
  const canonical = ['endpoints', 'models_list_url'] as const;
  const alias = ['endpoints', 'models_endpoint'] as const;
  const hasCanonical = hasPath(inspected, canonical);
  const hasAlias = hasPath(inspected, alias);
  if (hasCanonical && hasAlias) throw new Error('ambiguous alias: endpoints.models_list_url');
  return hasAlias ? alias : canonical;
}

function resolveAuthPath(inspected: Inspected, key: AuthKey): GrokPath {
  const authPath = ['auth', key] as const;
  const grokPath = ['grok_com_config', key] as const;
  const hasAuth = hasPath(inspected, authPath);
  const hasGrok = hasPath(inspected, grokPath);
  if (hasAuth && hasGrok) throw new Error(`ambiguous alias: ${key}`);
  if (hasAuth) return authPath;
  if (hasGrok) return grokPath;
  if (hasTable(inspected, GROK_COM_TABLE) && !hasTable(inspected, AUTH_TABLE)) return grokPath;
  return authPath;
}

function resolveTargets(inspected: Inspected, endpoint: string, command: string): { path: GrokPath; value: string }[] {
  const desired = desiredValues(endpoint, command);
  return [
    { path: ['endpoints', 'models_base_url'], value: desired.endpoints.models_base_url },
    { path: resolveCatalogPath(inspected), value: desired.endpoints.models_list_url },
    { path: ['endpoints', 'cli_chat_proxy_base_url'], value: desired.endpoints.cli_chat_proxy_base_url },
    { path: ['endpoints', 'xai_api_base_url'], value: desired.endpoints.xai_api_base_url },
    { path: ['endpoints', 'managed_config_url'], value: desired.endpoints.managed_config_url },
    { path: resolveAuthPath(inspected, 'auth_provider_command'), value: desired.auth.auth_provider_command },
    { path: resolveAuthPath(inspected, 'auth_provider_label'), value: desired.auth.auth_provider_label },
  ];
}

function mergeCreatedTables(
  previous: readonly GrokPath[] | undefined,
  created: readonly GrokPath[],
): readonly GrokPath[] {
  const merged: GrokPath[] = [...(previous ?? [])];
  const seen = new Set(merged.map(pathKey));
  for (const path of created) {
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(path);
  }
  return merged;
}

export function readGrokLeaf(text: string, path: GrokPath): LeafValue {
  let slot;
  try {
    slot = readTomlField(text, path, SYNTAX);
  } catch (error) {
    if (error instanceof Error && error.message === SCALAR_TYPE_ERROR) {
      throw new Error(`unsupported_managed_value: ${path.join('.')}`);
    }
    throw error;
  }
  if (slot.present) {
    if (typeof slot.value !== 'string') throw new Error(`unsupported_managed_value: ${path.join('.')}`);
    return { present: true, value: slot.value, raw: slot.raw };
  }
  if (hasTable(inspectTomlPaths(text, SYNTAX), path)) {
    throw new Error(`unsupported_managed_value: ${path.join('.')}`);
  }
  return { present: false };
}

function tryReadGrokLeaf(text: string, path: GrokPath): LeafValue | undefined {
  try {
    return readGrokLeaf(text, path);
  } catch (error) {
    if (isUnsupportedManagedValue(error)) return undefined;
    throw error;
  }
}

export function equalGrokLeaf(a: LeafValue, b: LeafValue): boolean {
  return a.present === b.present && (!a.present || (b.present && a.value === b.value));
}

function applyGrokChanges(text: string, changes: readonly FieldChange[], emptyTables: readonly GrokPath[]) {
  const edits: TomlFieldEdit[] = changes.map((change) => ({ path: change.path, next: change.after }));
  return editTomlFields(text, edits, { tomlVersion: '1.0', removeEmptyTables: emptyTables });
}

export function configureGrokToml(
  text: string,
  endpoint: string,
  command: string,
  previous?: { readonly leaves: readonly OwnedLeaf[]; readonly createdTables: readonly GrokPath[] },
): TomlEdit {
  const inspected = inspectTomlPaths(text, SYNTAX);
  const targets = resolveTargets(inspected, endpoint, command);
  if (previous !== undefined) {
    for (const leaf of previous.leaves) {
      const current = tryReadGrokLeaf(text, leaf.path);
      if (current === undefined || !equalGrokLeaf(current, leaf.written)) {
        throw new Error(`Grok configuration modified: ${leaf.path.join('.')}`);
      }
    }
  }
  const previousByPath = new Map((previous?.leaves ?? []).map((leaf) => [pathKey(leaf.path), leaf]));
  const snapshots = targets.map((target) => {
    const before = readGrokLeaf(text, target.path);
    return { ...target, before, original: previousByPath.get(pathKey(target.path))?.original ?? before };
  });
  const edits: TomlFieldEdit[] = snapshots.map((target) => ({
    path: target.path,
    next: { present: true, value: target.value },
  }));
  const edited = editTomlFields(text, edits, SYNTAX);
  const leaves: OwnedLeaf[] = snapshots.map((target) => ({
    path: target.path,
    original: target.original,
    written: readGrokLeaf(edited.text, target.path),
  }));
  const changes: FieldChange[] = leaves.map((leaf, index) => ({
    path: leaf.path,
    before: snapshots[index]!.before,
    after: leaf.written,
  }));
  return {
    text: edited.text,
    leaves,
    createdTables: mergeCreatedTables(previous?.createdTables, edited.createdTables),
    changes,
    skipped: [],
  };
}

export function restoreGrokToml(
  text: string,
  leaves: readonly OwnedLeaf[],
  createdTables: readonly GrokPath[],
): TomlEdit {
  const skipped: string[] = [];
  const changes: FieldChange[] = [];
  for (const leaf of leaves) {
    const current = tryReadGrokLeaf(text, leaf.path);
    if (current === undefined || !equalGrokLeaf(current, leaf.written)) {
      skipped.push(leaf.path.join('.'));
      continue;
    }
    if (equalGrokLeaf(current, leaf.original)) continue;
    changes.push({ path: leaf.path, before: current, after: leaf.original });
  }
  const edited = applyGrokChanges(text, changes, createdTables);
  const nextLeaves: OwnedLeaf[] = leaves.map((leaf) => {
    if (skipped.includes(leaf.path.join('.'))) return leaf;
    const written = tryReadGrokLeaf(edited.text, leaf.path) ?? leaf.original;
    return { path: leaf.path, original: leaf.original, written };
  });
  return { text: edited.text, leaves: nextLeaves, createdTables, changes, skipped };
}

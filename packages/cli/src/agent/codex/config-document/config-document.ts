import { parseTOML, type AST } from 'toml-eslint-parser';

import {
  editTomlFields,
  hasTomlTable,
  inspectTomlPaths,
  readTomlField,
  type TomlFieldEdit,
  type TomlPath,
} from '../../toml-document';

export type ManagedValue = string | boolean | number | readonly string[];
export type ValueSlot = { readonly present: false } | { readonly present: true; readonly value: ManagedValue };
export type FieldEdit = { readonly path: readonly string[]; readonly next: ValueSlot };
export type CodexDocument = {
  readonly text: string;
  readonly activeProviderId: string;
  readonly providerIds: readonly string[];
};

const SYNTAX = { tomlVersion: '1.1' as const };
const TYPE_ERROR = 'TOML field must be a string, boolean, finite integer, or string array';

const samePath = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const pathKey = (path: readonly string[]): string => JSON.stringify(path);

function parseCodexDocument(text: string): void {
  parseTOML(text, { tomlVersion: '1.1' });
}

export function readManagedField(text: string, path: readonly string[]): ValueSlot {
  try {
    const slot = readTomlField(text, path, SYNTAX);
    return slot.present ? { present: true, value: slot.value } : { present: false };
  } catch (error) {
    if (error instanceof Error && error.message === TYPE_ERROR) {
      throw new Error(`Managed field ${path.join('.')} must be a string or boolean, finite integer, or string array`);
    }
    throw error;
  }
}

export function hasCodexTable(text: string, path: readonly string[]): boolean {
  parseCodexDocument(text);
  return hasTomlTable(text, path, SYNTAX);
}

export function readCodexDocument(text: string): CodexDocument {
  parseCodexDocument(text);
  const inspected = inspectTomlPaths(text, SYNTAX);
  const active = readManagedField(text, ['model_provider']);
  // Resolve the value first, then assert on the resolved string: checking `present` and the value's
  // type as one condition validates but narrows nothing, leaving `ManagedValue` at the use site.
  const activeProviderId = active.present ? active.value : '';
  if (typeof activeProviderId !== 'string') throw new Error('model_provider must be a TOML string');
  const providerIds = new Set<string>();
  for (const path of [...inspected.tablePaths, ...inspected.fieldPaths]) {
    if (path.length >= 2 && path[0] === 'model_providers') providerIds.add(path[1]!);
  }
  return {
    text,
    activeProviderId,
    providerIds: [...providerIds],
  };
}

function hasStandardTable(text: string, path: readonly string[]): boolean {
  const topLevel = parseTOML(text, { tomlVersion: '1.1' }).body[0];
  return (
    topLevel?.body.some((entry) => entry.type === 'TOMLTable' && samePath(entry.resolvedKey.map(String), path)) === true
  );
}

function assertProviderDeletes(text: string, edits: readonly FieldEdit[]): void {
  const inspected = inspectTomlPaths(text, SYNTAX);
  const deleted = new Set(edits.filter((edit) => !edit.next.present).map((edit) => pathKey(edit.path)));
  for (const edit of edits) {
    if (edit.next.present || edit.path.length !== 2 || edit.path[0] !== 'model_providers') continue;
    if (!hasStandardTable(text, edit.path)) continue;
    const leftover = inspected.fieldPaths.some(
      (field) =>
        field.length >= 3 && field[0] === edit.path[0] && field[1] === edit.path[1] && !deleted.has(pathKey(field)),
    );
    if (leftover) throw new Error('Managed provider table cannot be deleted while preserving unrelated fields');
  }
}

function assertCreatable(text: string, edit: FieldEdit): void {
  if (!edit.next.present) return;
  const existing = inspectTomlPaths(text, SYNTAX).fieldPaths.some((path) => samePath(path, edit.path));
  if (existing) return;
  if (edit.path.length === 1) return;
  if (edit.path[0] === 'model_providers' && (edit.path.length === 3 || edit.path.length === 4)) return;
  throw new Error(`Cannot create nested TOML field ${edit.path.join('.')}`);
}

function fieldKeyParts(key: AST.TOMLKey): string[] {
  return key.keys.map((part) => (part.type === 'TOMLBare' ? part.name : part.value));
}

function providerTablesToPrune(text: string, edits: readonly FieldEdit[]): readonly TomlPath[] {
  const deleted = new Set(edits.filter((edit) => !edit.next.present).map((edit) => pathKey(edit.path)));
  if (deleted.size === 0) return [];
  const tables: TomlPath[] = [];
  const seen = new Set<string>();
  for (const entry of parseTOML(text, { tomlVersion: '1.1' }).body[0]?.body ?? []) {
    if (entry.type !== 'TOMLTable') continue;
    const tablePath = entry.resolvedKey.map(String);
    if (tablePath[0] !== 'model_providers' || (tablePath.length !== 2 && tablePath.length !== 3)) continue;
    const tableDeleted = deleted.has(pathKey(tablePath));
    if (tablePath.length === 3 && !tableDeleted) continue;
    const bodyCleared =
      entry.body.length > 0 &&
      entry.body.every((field) => deleted.has(pathKey([...tablePath, ...fieldKeyParts(field.key)])));
    if (!tableDeleted && !bodyCleared) continue;
    const key = pathKey(tablePath);
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push(tablePath);
  }
  return tables;
}

export function editCodexDocument(text: string, edits: readonly FieldEdit[]): string {
  parseCodexDocument(text);
  for (const edit of edits) {
    if (edit.path.length === 0) throw new Error('Managed TOML field path cannot be empty');
    assertCreatable(text, edit);
  }
  assertProviderDeletes(text, edits);
  const mapped: TomlFieldEdit[] = edits.map((edit) =>
    edit.next.present
      ? { path: edit.path, next: { present: true, value: edit.next.value } }
      : { path: edit.path, next: { present: false } },
  );
  return editTomlFields(text, mapped, {
    tomlVersion: '1.1',
    tableCreation: 'header',
    removeEmptyTables: providerTablesToPrune(text, edits),
  }).text;
}

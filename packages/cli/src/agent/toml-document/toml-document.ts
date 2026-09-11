import { parseTOML, type AST } from 'toml-eslint-parser';

import { applySourceEdits, encodeTomlValue, samePath } from './ast-edits';
import {
  collectPaths,
  emptyTableHeaderEdit,
  findTable,
  findValue,
  inspectDocument,
  planTomlEdits,
  tableIsEmpty,
  type EncodedFieldEdit,
} from './path-edits';

export type TomlPath = readonly string[];
export type TomlScalar = string | boolean;
export type TomlSyntax = { readonly tomlVersion: '1.0' | '1.1' };
export type TomlSlot =
  | { readonly present: false }
  | { readonly present: true; readonly value: TomlScalar; readonly raw: string };
export type TomlFieldEdit = {
  readonly path: TomlPath;
  readonly next:
    | { readonly present: false }
    | { readonly present: true; readonly value: TomlScalar; readonly raw?: string };
};
export type TomlEditOptions = TomlSyntax & { readonly removeEmptyTables?: readonly TomlPath[] };
export type TomlEditResult = { readonly text: string; readonly createdTables: readonly TomlPath[] };

const SCALAR_TYPE_ERROR = 'TOML field must be a string or boolean';
const INVALID_DOCUMENT = 'Invalid TOML document';
const INVALID_EDITED_DOCUMENT = 'Edited TOML document is invalid';
const INVALID_VALUE_LITERAL = 'Invalid TOML value literal';

function parseDocument(text: string, syntax: TomlSyntax): AST.TOMLProgram {
  try {
    return parseTOML(text, { tomlVersion: syntax.tomlVersion });
  } catch {
    throw new Error(INVALID_DOCUMENT);
  }
}

function validateFinalDocument(text: string, syntax: TomlSyntax): void {
  parseDocument(text, syntax);
  try {
    Bun.TOML.parse(text);
  } catch {
    throw new Error(INVALID_EDITED_DOCUMENT);
  }
}

const scalarFromNode = (node: AST.TOMLValue): TomlScalar | undefined => {
  if (node.kind === 'string' || node.kind === 'boolean') return node.value;
  return undefined;
};

export function readTomlField(text: string, path: TomlPath, syntax: TomlSyntax): TomlSlot {
  const document = inspectDocument(parseDocument(text, syntax));
  const value = findValue(document, path);
  if (value === undefined) return { present: false };
  if (value.keyValue.value.type !== 'TOMLValue') throw new Error(SCALAR_TYPE_ERROR);
  const scalar = scalarFromNode(value.keyValue.value);
  if (scalar === undefined) throw new Error(SCALAR_TYPE_ERROR);
  return {
    present: true,
    value: scalar,
    raw: text.slice(value.keyValue.value.range[0], value.keyValue.value.range[1]),
  };
}

export function inspectTomlPaths(
  text: string,
  syntax: TomlSyntax,
): { readonly fieldPaths: readonly TomlPath[]; readonly tablePaths: readonly TomlPath[] } {
  return collectPaths(inspectDocument(parseDocument(text, syntax)));
}

const assertSafeRawLiteral = (raw: string, expected: TomlScalar, syntax: TomlSyntax): void => {
  const temp = `value = ${raw}`;
  let slot: TomlSlot;
  try {
    slot = readTomlField(temp, ['value'], syntax);
  } catch {
    throw new Error(INVALID_VALUE_LITERAL);
  }
  if (!slot.present || slot.value !== expected) throw new Error(INVALID_VALUE_LITERAL);
  const inspected = inspectTomlPaths(temp, syntax);
  if (inspected.fieldPaths.length !== 1 || !samePath(inspected.fieldPaths[0]!, ['value'])) {
    throw new Error(INVALID_VALUE_LITERAL);
  }
  if (inspected.tablePaths.length !== 0) throw new Error(INVALID_VALUE_LITERAL);
  const ast = parseDocument(temp, syntax);
  if (ast.comments.length > 0) throw new Error(INVALID_VALUE_LITERAL);
  const body = ast.body[0]?.body ?? [];
  if (body.length !== 1 || body[0]?.type !== 'TOMLKeyValue') throw new Error(INVALID_VALUE_LITERAL);
  const valueRaw = temp.slice(body[0].value.range[0], body[0].value.range[1]);
  if (raw !== valueRaw) throw new Error(INVALID_VALUE_LITERAL);
};

const encodeEdit = (text: string, edit: TomlFieldEdit, syntax: TomlSyntax): EncodedFieldEdit => {
  if (!edit.next.present) return { path: edit.path, next: { present: false } };
  if (edit.next.raw !== undefined) {
    assertSafeRawLiteral(edit.next.raw, edit.next.value, syntax);
    return { path: edit.path, next: { present: true, encoded: edit.next.raw } };
  }
  const current = readTomlField(text, edit.path, syntax);
  if (current.present && current.value === edit.next.value) {
    return { path: edit.path, next: { present: true, encoded: current.raw } };
  }
  return { path: edit.path, next: { present: true, encoded: encodeTomlValue(edit.next.value) } };
};

const pruneEmptyTables = (text: string, tables: readonly TomlPath[], syntax: TomlSyntax): string => {
  if (tables.length === 0) return text;
  const document = inspectDocument(parseDocument(text, syntax));
  const edits = [];
  for (const path of tables) {
    const table = findTable(document, path);
    if (table === undefined || table.kind !== 'standard') continue;
    if (!tableIsEmpty(document, table)) continue;
    edits.push(emptyTableHeaderEdit(text, table));
  }
  if (edits.length === 0) return text;
  const result = applySourceEdits(text, edits);
  validateFinalDocument(result, syntax);
  return result;
};

export function editTomlFields(
  text: string,
  edits: readonly TomlFieldEdit[],
  options: TomlEditOptions,
): TomlEditResult {
  const encoded = edits.map((edit) => encodeEdit(text, edit, options));
  const document = inspectDocument(parseDocument(text, options));
  const planned = planTomlEdits(text, document, encoded);
  const next = applySourceEdits(text, planned.sourceEdits);
  validateFinalDocument(next, options);
  const pruned = pruneEmptyTables(next, options.removeEmptyTables ?? [], options);
  return { text: pruned, createdTables: planned.createdTables };
}

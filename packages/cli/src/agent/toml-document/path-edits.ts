import type { AST } from 'toml-eslint-parser';

import {
  applyInlineOperations,
  encodeTomlKey,
  inlineMemberDeletes,
  isPrefix,
  lineEndingFor,
  lineStart,
  textAfterLine,
  type InlineOperation,
  type SourceEdit,
} from './ast-edits';
import { findInlineContainer, findTable, findValue, hasArrayTableAncestor, type InspectedDocument } from './inspect';

export type EncodedFieldEdit = {
  readonly path: readonly string[];
  readonly next: { readonly present: false } | { readonly present: true; readonly encoded: string };
};
export type PlannedTomlEdits = {
  readonly sourceEdits: readonly SourceEdit[];
  readonly createdTables: readonly (readonly string[])[];
};
export type TomlTableCreation = 'dotted' | 'header';

const sourceInsertionPrefix = (source: string, position: number, ending: string): string =>
  position > 0 && source[position - 1] !== '\n' ? ending : '';

const trailingLineComment = (afterValue: string): string | undefined => {
  const comment = /^[ \t]*(#[^\n]*)(\r?\n)?$/u.exec(afterValue);
  if (comment?.[1] === undefined) return undefined;
  return `${comment[1]}${comment[2] ?? ''}`;
};

export const lineDelete = (source: string, range: readonly [number, number]): SourceEdit => {
  const start = lineStart(source, range[0]);
  const end = textAfterLine(source, range[1]);
  return { start, end, text: trailingLineComment(source.slice(range[1], end)) ?? '' };
};

const tableInsertionPoint = (source: string, table: AST.TOMLTable, tables: readonly AST.TOMLTable[]): number => {
  const nextTable = tables.find((candidate) => candidate.range[0] > table.range[0]);
  if (nextTable !== undefined) return nextTable.range[0];
  const last = table.body.at(-1);
  return textAfterLine(source, last?.range[1] ?? table.range[1]);
};

const topLevelInsertionPoint = (source: string, document: InspectedDocument): number => {
  const firstTable = document.tables[0];
  return firstTable?.range[0] ?? source.length;
};

const lastImplicitSibling = (
  source: string,
  document: InspectedDocument,
  path: readonly string[],
): { readonly prefix: readonly string[]; readonly after: number } | undefined => {
  for (let index = path.length - 1; index >= 1; index -= 1) {
    const prefix = path.slice(0, index);
    if (findTable(document, prefix) !== undefined || findInlineContainer(document, prefix) !== undefined) continue;
    const siblings = document.values.filter(
      (value) =>
        value.container.type === 'TOMLTopLevelTable' &&
        isPrefix(prefix, value.path) &&
        value.path.length > prefix.length,
    );
    if (siblings.length === 0) continue;
    const last = siblings.reduce((current, value) =>
      value.keyValue.range[1] > current.keyValue.range[1] ? value : current,
    );
    return { prefix, after: textAfterLine(source, last.keyValue.range[1]) };
  }
  return undefined;
};

const encodeDottedKey = (path: readonly string[]): string => path.map(encodeTomlKey).join('.');

const fieldAssignment = (path: readonly string[], encoded: string): string => `${encodeDottedKey(path)} = ${encoded}`;

const groupedInlineInserts = (
  inserts: readonly { readonly remaining: readonly string[]; readonly encoded: string }[],
): string[] => {
  const leaves: string[] = [];
  const nested = new Map<string, { remaining: string[]; encoded: string }[]>();
  for (const insert of inserts) {
    if (insert.remaining.length === 1) {
      leaves.push(fieldAssignment(insert.remaining, insert.encoded));
      continue;
    }
    const head = insert.remaining[0]!;
    const group = nested.get(head) ?? [];
    group.push({ remaining: [...insert.remaining.slice(1)], encoded: insert.encoded });
    nested.set(head, group);
  }
  const nestedText = [...nested].map(([head, group]) => {
    const inner = groupedInlineInserts(group);
    return `${encodeTomlKey(head)} = { ${inner.join(', ')} }`;
  });
  return [...leaves, ...nestedText];
};

type InlinePlan = {
  readonly deletes: AST.TOMLKeyValue[];
  readonly replaces: InlineOperation[];
  readonly inserts: { remaining: readonly string[]; encoded: string }[];
};

type NewTable = {
  readonly path: readonly string[];
  readonly fields: string[];
  readonly afterTable?: AST.TOMLTable;
};

const getInlinePlan = (plans: Map<AST.TOMLInlineTable, InlinePlan>, container: AST.TOMLInlineTable): InlinePlan => {
  const existing = plans.get(container);
  if (existing !== undefined) return existing;
  const created: InlinePlan = { deletes: [], replaces: [], inserts: [] };
  plans.set(container, created);
  return created;
};

const assertInsertable = (document: InspectedDocument, path: readonly string[]): void => {
  if (hasArrayTableAncestor(document, path)) {
    throw new Error('Cannot edit a field under a TOML array table');
  }
  for (let index = 1; index < path.length; index += 1) {
    const prefix = path.slice(0, index);
    const value = findValue(document, prefix);
    if (value === undefined) continue;
    if (value.keyValue.value.type === 'TOMLInlineTable') continue;
    if (value.keyValue.value.type === 'TOMLArray') {
      throw new Error('Cannot edit a field under a TOML array');
    }
    throw new Error('Cannot edit a field under a TOML scalar');
  }
};

const addNewTableField = (
  newTables: Map<string, NewTable>,
  path: readonly string[],
  assignment: string,
  afterTable?: AST.TOMLTable,
): boolean => {
  const key = JSON.stringify(path);
  const existing = newTables.get(key);
  if (existing !== undefined) {
    existing.fields.push(assignment);
    return false;
  }
  newTables.set(key, { path, fields: [assignment], ...(afterTable === undefined ? {} : { afterTable }) });
  return true;
};

const planImplicitInsert = (
  source: string,
  document: InspectedDocument,
  edit: EncodedFieldEdit & { readonly next: { readonly present: true; readonly encoded: string } },
  tableCreation: TomlTableCreation,
  newTables: Map<string, NewTable>,
  implicitFields: Map<string, { after: number; fields: string[] }>,
  addCreatedTable: (path: readonly string[]) => void,
): boolean => {
  const implicit = lastImplicitSibling(source, document, edit.path);
  if (implicit === undefined) return false;
  const parentPath = edit.path.slice(0, -1);
  if (
    tableCreation === 'header' &&
    parentPath.length > implicit.prefix.length &&
    isPrefix(implicit.prefix, parentPath)
  ) {
    if (addNewTableField(newTables, parentPath, `${encodeTomlKey(edit.path.at(-1)!)} = ${edit.next.encoded}`)) {
      addCreatedTable(parentPath);
    }
    return true;
  }
  const key = JSON.stringify(implicit.prefix);
  const assignment = fieldAssignment(edit.path, edit.next.encoded);
  const existingImplicit = implicitFields.get(key);
  if (existingImplicit !== undefined) {
    existingImplicit.fields.push(assignment);
    if (implicit.after > existingImplicit.after) existingImplicit.after = implicit.after;
  } else {
    implicitFields.set(key, { after: implicit.after, fields: [assignment] });
  }
  return true;
};

const inlinePlanOperations = (source: string, container: AST.TOMLInlineTable, plan: InlinePlan): InlineOperation[] => {
  const deletes = [...new Set(plan.deletes)];
  const remaining = container.body.filter((member) => !deletes.includes(member));
  const operations: InlineOperation[] = [...inlineMemberDeletes(source, container.body, deletes), ...plan.replaces];
  const insertText = groupedInlineInserts(plan.inserts);
  if (insertText.length > 0) {
    operations.push({
      kind: 'insert',
      start: remaining.at(-1)?.range[1] ?? container.range[1] - 1,
      text: `${remaining.length > 0 ? ', ' : ''}${insertText.join(', ')}`,
    });
  }
  return operations;
};

const coalesceInlineOperations = (
  plans: Map<AST.TOMLInlineTable, InlineOperation[]>,
): Map<AST.TOMLInlineTable, InlineOperation[]> => {
  const coalesced = new Map<AST.TOMLInlineTable, InlineOperation[]>();
  for (const [container, operations] of plans) {
    let scope = container;
    for (const candidate of plans.keys()) {
      if (
        candidate !== container &&
        candidate.range[0] <= scope.range[0] &&
        candidate.range[1] >= scope.range[1] &&
        candidate.range[1] - candidate.range[0] > scope.range[1] - scope.range[0]
      ) {
        scope = candidate;
      }
    }
    const scoped = coalesced.get(scope) ?? [];
    scoped.push(...operations);
    coalesced.set(scope, scoped);
  }
  return coalesced;
};

export const planTomlEdits = (
  source: string,
  document: InspectedDocument,
  edits: readonly EncodedFieldEdit[],
  tableCreation: TomlTableCreation = 'dotted',
): PlannedTomlEdits => {
  const sourceEdits: SourceEdit[] = [];
  const createdTables: Array<readonly string[]> = [];
  const createdKeys = new Set<string>();
  const inlinePlans = new Map<AST.TOMLInlineTable, InlinePlan>();
  const tableFields = new Map<AST.TOMLTable, string[]>();
  const topLevelFields: string[] = [];
  const newTables = new Map<string, NewTable>();
  const implicitFields = new Map<string, { after: number; fields: string[] }>();
  const ending = lineEndingFor(source);

  const addCreatedTable = (path: readonly string[]): void => {
    const key = JSON.stringify(path);
    if (createdKeys.has(key)) return;
    createdKeys.add(key);
    createdTables.push(path);
  };

  for (const edit of edits) {
    if (edit.path.length === 0) throw new Error('TOML field path cannot be empty');
    const existing = findValue(document, edit.path);
    if (existing !== undefined) {
      if (!edit.next.present) {
        if (existing.container.type === 'TOMLInlineTable') {
          getInlinePlan(inlinePlans, existing.container).deletes.push(existing.keyValue);
        } else {
          sourceEdits.push(lineDelete(source, existing.keyValue.range));
        }
      } else {
        const currentRaw = source.slice(existing.keyValue.value.range[0], existing.keyValue.value.range[1]);
        if (currentRaw === edit.next.encoded) continue;
        const replace: InlineOperation = {
          kind: 'replace',
          start: existing.keyValue.value.range[0],
          end: existing.keyValue.value.range[1],
          text: edit.next.encoded,
        };
        if (existing.container.type === 'TOMLInlineTable') {
          getInlinePlan(inlinePlans, existing.container).replaces.push(replace);
        } else {
          sourceEdits.push({ start: replace.start, end: replace.end, text: replace.text });
        }
      }
      continue;
    }
    if (!edit.next.present) continue;
    assertInsertable(document, edit.path);
    let located = false;
    for (let index = edit.path.length - 1; index >= 1; index -= 1) {
      const prefix = edit.path.slice(0, index);
      const inline = findInlineContainer(document, prefix);
      if (inline !== undefined) {
        getInlinePlan(inlinePlans, inline).inserts.push({
          remaining: edit.path.slice(index),
          encoded: edit.next.encoded,
        });
        located = true;
        break;
      }
      const table = findTable(document, prefix);
      if (table !== undefined) {
        if (table.kind === 'array') throw new Error('Cannot edit a field under a TOML array table');
        const remaining = edit.path.slice(index);
        if (tableCreation === 'header' && remaining.length > 1) {
          const nestedPath = edit.path.slice(0, -1);
          if (
            addNewTableField(newTables, nestedPath, `${encodeTomlKey(edit.path.at(-1)!)} = ${edit.next.encoded}`, table)
          ) {
            addCreatedTable(nestedPath);
          }
        } else {
          const fields = tableFields.get(table) ?? [];
          fields.push(fieldAssignment(remaining, edit.next.encoded));
          tableFields.set(table, fields);
        }
        located = true;
        break;
      }
    }
    if (located) continue;
    if (
      planImplicitInsert(
        source,
        document,
        { path: edit.path, next: edit.next },
        tableCreation,
        newTables,
        implicitFields,
        addCreatedTable,
      )
    ) {
      continue;
    }
    if (edit.path.length === 1) {
      topLevelFields.push(fieldAssignment(edit.path, edit.next.encoded));
      continue;
    }
    const parentPath = edit.path.slice(0, -1);
    if (addNewTableField(newTables, parentPath, `${encodeTomlKey(edit.path.at(-1)!)} = ${edit.next.encoded}`)) {
      addCreatedTable(parentPath);
    }
  }

  if (topLevelFields.length > 0) {
    const position = topLevelInsertionPoint(source, document);
    sourceEdits.push({
      start: position,
      end: position,
      text: `${sourceInsertionPrefix(source, position, ending)}${topLevelFields.join(ending)}${ending}`,
    });
  }
  for (const [table, fields] of tableFields) {
    const position = tableInsertionPoint(source, table, document.tables);
    sourceEdits.push({
      start: position,
      end: position,
      text: `${sourceInsertionPrefix(source, position, ending)}${fields.join(ending)}${ending}`,
    });
  }
  for (const { after, fields } of implicitFields.values()) {
    sourceEdits.push({
      start: after,
      end: after,
      text: `${sourceInsertionPrefix(source, after, ending)}${fields.join(ending)}${ending}`,
    });
  }
  for (const { path, fields, afterTable } of newTables.values()) {
    const block = `[${encodeDottedKey(path)}]${ending}${fields.join(ending)}${ending}`;
    if (afterTable !== undefined) {
      const start = tableInsertionPoint(source, afterTable, document.tables);
      sourceEdits.push({
        start,
        end: start,
        text: `${sourceInsertionPrefix(source, start, ending)}${block}`,
      });
      continue;
    }
    const prefix = source.length > 0 && !source.endsWith('\n') ? ending : '';
    sourceEdits.push({ start: source.length, end: source.length, text: `${prefix}${block}` });
  }
  const operationsByContainer = new Map<AST.TOMLInlineTable, InlineOperation[]>();
  for (const [container, plan] of inlinePlans) {
    operationsByContainer.set(container, inlinePlanOperations(source, container, plan));
  }
  for (const [container, operations] of coalesceInlineOperations(operationsByContainer)) {
    sourceEdits.push(applyInlineOperations(source, container.range, operations));
  }
  return { sourceEdits, createdTables };
};

export const emptyTableHeaderEdit = (source: string, table: AST.TOMLTable): SourceEdit =>
  lineDelete(source, [table.range[0], table.body.at(-1)?.range[1] ?? table.range[1]]);

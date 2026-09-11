import type { AST } from 'toml-eslint-parser';

import {
  applyInlineOperations,
  encodeTomlKey,
  inlineMemberDeletes,
  isPrefix,
  keyParts,
  lineEndingFor,
  lineStart,
  samePath,
  textAfterLine,
  type InlineOperation,
  type SourceEdit,
} from './ast-edits';

export type Container = AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable;
export type LocatedValue = {
  readonly keyValue: AST.TOMLKeyValue;
  readonly path: readonly string[];
  readonly container: Container;
};
export type InspectedDocument = {
  readonly values: readonly LocatedValue[];
  readonly tables: readonly AST.TOMLTable[];
  readonly topLevel: AST.TOMLTopLevelTable;
};
export type EncodedFieldEdit = {
  readonly path: readonly string[];
  readonly next: { readonly present: false } | { readonly present: true; readonly encoded: string };
};
export type PlannedTomlEdits = {
  readonly sourceEdits: readonly SourceEdit[];
  readonly createdTables: readonly (readonly string[])[];
};

const tablePath = (table: AST.TOMLTable): string[] => table.resolvedKey.map(String);

const arrayTableNames = (table: AST.TOMLTable): string[] =>
  table.resolvedKey.filter((part): part is string => typeof part === 'string');

export const walkKeyValues = (
  values: readonly AST.TOMLKeyValue[],
  prefix: readonly string[],
  container: Container,
  output: LocatedValue[],
): void => {
  for (const keyValue of values) {
    const path = [...prefix, ...keyParts(keyValue.key)];
    output.push({ keyValue, path, container });
    if (keyValue.value.type === 'TOMLInlineTable') walkKeyValues(keyValue.value.body, path, keyValue.value, output);
  }
};

export const inspectDocument = (ast: AST.TOMLProgram): InspectedDocument => {
  const topLevel = ast.body[0]!;
  const values: LocatedValue[] = [];
  const tables = topLevel.body.filter((entry): entry is AST.TOMLTable => entry.type === 'TOMLTable');
  walkKeyValues(
    topLevel.body.filter((entry): entry is AST.TOMLKeyValue => entry.type === 'TOMLKeyValue'),
    [],
    topLevel,
    values,
  );
  for (const table of tables) walkKeyValues(table.body, tablePath(table), table, values);
  return { values, tables, topLevel };
};

export const findValue = (document: InspectedDocument, path: readonly string[]): LocatedValue | undefined =>
  document.values.find((value) => samePath(value.path, path));

export const findTable = (document: InspectedDocument, path: readonly string[]): AST.TOMLTable | undefined =>
  document.tables.find((table) => samePath(tablePath(table), path));

export const findInlineContainer = (
  document: InspectedDocument,
  path: readonly string[],
): AST.TOMLInlineTable | undefined => {
  const value = findValue(document, path);
  return value?.keyValue.value.type === 'TOMLInlineTable' ? value.keyValue.value : undefined;
};

export const collectPaths = (
  document: InspectedDocument,
): { readonly fieldPaths: readonly (readonly string[])[]; readonly tablePaths: readonly (readonly string[])[] } => {
  const fieldKeys = new Set<string>();
  const tableKeys = new Set<string>();
  const fieldPaths: string[][] = [];
  const tablePaths: string[][] = [];
  const addTable = (path: readonly string[]): void => {
    if (path.length === 0) return;
    const key = JSON.stringify(path);
    if (tableKeys.has(key)) return;
    tableKeys.add(key);
    tablePaths.push([...path]);
  };
  const addImplicitParents = (path: readonly string[]): void => {
    for (let index = 1; index < path.length; index += 1) addTable(path.slice(0, index));
  };
  for (const value of document.values) {
    const key = JSON.stringify(value.path);
    if (!fieldKeys.has(key)) {
      fieldKeys.add(key);
      fieldPaths.push([...value.path]);
    }
    addImplicitParents(value.path);
    if (value.keyValue.value.type === 'TOMLInlineTable') addTable(value.path);
  }
  for (const table of document.tables) {
    const path = tablePath(table);
    addTable(path);
    addImplicitParents(path);
  }
  return { fieldPaths, tablePaths };
};

export const hasArrayTableAncestor = (document: InspectedDocument, path: readonly string[]): boolean =>
  document.tables.some((table) => {
    if (table.kind !== 'array') return false;
    const names = arrayTableNames(table);
    return names.length > 0 && isPrefix(names, path);
  });

const sourceInsertionPrefix = (source: string, position: number, ending: string): string =>
  position > 0 && source[position - 1] !== '\n' ? ending : '';

const trailingLineComment = (afterValue: string): string | undefined => {
  const comment = /^[ \t]*(#[^\n]*)(\r?\n)?$/u.exec(afterValue);
  if (comment?.[1] === undefined) return undefined;
  return `${comment[1]}${comment[2] ?? ''}`;
};

const lineDelete = (source: string, range: readonly [number, number]): SourceEdit => {
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

export const planTomlEdits = (
  source: string,
  document: InspectedDocument,
  edits: readonly EncodedFieldEdit[],
): PlannedTomlEdits => {
  const sourceEdits: SourceEdit[] = [];
  const createdTables: Array<readonly string[]> = [];
  const createdKeys = new Set<string>();
  const inlinePlans = new Map<AST.TOMLInlineTable, InlinePlan>();
  const tableFields = new Map<AST.TOMLTable, string[]>();
  const topLevelFields: string[] = [];
  const newTables = new Map<string, { path: readonly string[]; fields: string[] }>();
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
    if (!edit.next.present) {
      const table = findTable(document, edit.path);
      if (table !== undefined && table.kind === 'standard') {
        sourceEdits.push(lineDelete(source, [table.range[0], table.body.at(-1)?.range[1] ?? table.range[1]]));
      }
      continue;
    }
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
        const fields = tableFields.get(table) ?? [];
        fields.push(fieldAssignment(edit.path.slice(index), edit.next.encoded));
        tableFields.set(table, fields);
        located = true;
        break;
      }
    }
    if (located) continue;
    const implicit = lastImplicitSibling(source, document, edit.path);
    if (implicit !== undefined) {
      const key = JSON.stringify(implicit.prefix);
      const assignment = fieldAssignment(edit.path, edit.next.encoded);
      const existing = implicitFields.get(key);
      if (existing !== undefined) {
        existing.fields.push(assignment);
        if (implicit.after > existing.after) existing.after = implicit.after;
      } else {
        implicitFields.set(key, { after: implicit.after, fields: [assignment] });
      }
      continue;
    }
    if (edit.path.length === 1) {
      topLevelFields.push(fieldAssignment(edit.path, edit.next.encoded));
      continue;
    }
    const parentPath = edit.path.slice(0, -1);
    const key = JSON.stringify(parentPath);
    const existingNew = newTables.get(key);
    const assignment = `${encodeTomlKey(edit.path.at(-1)!)} = ${edit.next.encoded}`;
    if (existingNew !== undefined) {
      existingNew.fields.push(assignment);
    } else {
      newTables.set(key, { path: parentPath, fields: [assignment] });
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
  for (const { path, fields } of newTables.values()) {
    const prefix = source.length > 0 && !source.endsWith('\n') ? ending : '';
    sourceEdits.push({
      start: source.length,
      end: source.length,
      text: `${prefix}[${encodeDottedKey(path)}]${ending}${fields.join(ending)}${ending}`,
    });
  }
  for (const [container, plan] of inlinePlans) {
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
    sourceEdits.push(applyInlineOperations(source, container.range, operations));
  }
  return { sourceEdits, createdTables };
};

export const emptyTableHeaderEdit = (source: string, table: AST.TOMLTable): SourceEdit => ({
  start: lineStart(source, table.range[0]),
  end: textAfterLine(source, table.body.at(-1)?.range[1] ?? table.range[1]),
  text: '',
});

export const tableIsEmpty = (document: InspectedDocument, table: AST.TOMLTable): boolean => {
  if (table.body.length > 0) return false;
  const path = tablePath(table);
  return !document.tables.some((candidate) => {
    if (candidate === table) return false;
    return isPrefix(path, tablePath(candidate));
  });
};

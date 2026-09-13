import type { AST } from 'toml-eslint-parser';

import { isPrefix, keyParts, samePath } from './ast-edits';

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

export const tablePath = (table: AST.TOMLTable): string[] => table.resolvedKey.map(String);

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

export const tableIsEmpty = (document: InspectedDocument, table: AST.TOMLTable): boolean => {
  if (table.body.length > 0) return false;
  const path = tablePath(table);
  return !document.tables.some((candidate) => {
    if (candidate === table) return false;
    return isPrefix(path, tablePath(candidate));
  });
};

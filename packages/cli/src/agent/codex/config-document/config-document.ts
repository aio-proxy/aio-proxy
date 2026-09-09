import { parseTOML, type AST } from 'toml-eslint-parser';

import {
  applyInlineOperations,
  applySourceEdits,
  encodeTomlKey,
  encodeTomlValue,
  inlineMemberDelete,
  keyParts,
  lineEndingFor,
  lineStart,
  samePath,
  textAfterLine,
  type InlineOperation,
  type SourceEdit,
} from './ast-edits';

export type ManagedValue = string | boolean;
export type ValueSlot = { readonly present: false } | { readonly present: true; readonly value: ManagedValue };
export type FieldEdit = { readonly path: readonly string[]; readonly next: ValueSlot };
export type CodexDocument = {
  readonly text: string;
  readonly activeProviderId: string;
  readonly providerIds: readonly string[];
};

type Container = AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable;
type LocatedValue = {
  readonly keyValue: AST.TOMLKeyValue;
  readonly path: readonly string[];
  readonly container: Container;
};

const parseDocument = (text: string): AST.TOMLProgram => parseTOML(text, { tomlVersion: '1.1' });

const walkKeyValues = (
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

const inspectDocument = (
  ast: AST.TOMLProgram,
): {
  readonly values: readonly LocatedValue[];
  readonly tables: readonly AST.TOMLTable[];
  readonly topLevel: AST.TOMLTopLevelTable;
} => {
  const topLevel = ast.body[0]!;
  const values: LocatedValue[] = [];
  const tables = topLevel.body.filter((entry): entry is AST.TOMLTable => entry.type === 'TOMLTable');
  walkKeyValues(
    topLevel.body.filter((entry): entry is AST.TOMLKeyValue => entry.type === 'TOMLKeyValue'),
    [],
    topLevel,
    values,
  );
  for (const table of tables) walkKeyValues(table.body, table.resolvedKey.map(String), table, values);
  return { values, tables, topLevel };
};

const findValue = (document: ReturnType<typeof inspectDocument>, path: readonly string[]): LocatedValue | undefined =>
  document.values.find((value) => samePath(value.path, path));

const findTable = (document: ReturnType<typeof inspectDocument>, path: readonly string[]): AST.TOMLTable | undefined =>
  document.tables.find((table) => samePath(table.resolvedKey.map(String), path));

const findInlineContainer = (
  document: ReturnType<typeof inspectDocument>,
  path: readonly string[],
): AST.TOMLInlineTable | undefined => {
  const value = findValue(document, path);
  return value?.keyValue.value.type === 'TOMLInlineTable' ? value.keyValue.value : undefined;
};

const valueFromNode = (node: AST.TOMLValue): ManagedValue | undefined => {
  if (node.kind === 'string' || node.kind === 'boolean') return node.value as ManagedValue;
  return undefined;
};

const managedValue = (value: LocatedValue): ManagedValue => {
  if (value.keyValue.value.type !== 'TOMLValue') {
    throw new Error(`Managed field ${value.path.join('.')} must be a TOML string or boolean`);
  }
  const result = valueFromNode(value.keyValue.value);
  if (result === undefined) throw new Error(`Managed field ${value.path.join('.')} must be a TOML string or boolean`);
  return result;
};

const topLevelInsertionPoint = (source: string, document: ReturnType<typeof inspectDocument>): number => {
  const firstTable = document.tables[0];
  return firstTable?.range[0] ?? source.length;
};

const sourceInsertionPrefix = (source: string, position: number, ending: string): string =>
  position > 0 && source[position - 1] !== '\n' ? ending : '';

const fieldLines = (fields: readonly (readonly [string, ManagedValue])[], ending: string): string =>
  fields.map(([key, value]) => `${encodeTomlKey(key)} = ${encodeTomlValue(value)}`).join(ending) + ending;

const tableInsertionPoint = (source: string, table: AST.TOMLTable, tables: readonly AST.TOMLTable[]): number => {
  const nextTable = tables.find((candidate) => candidate.range[0] > table.range[0]);
  if (nextTable !== undefined) return nextTable.range[0];
  const last = table.body.at(-1);
  return textAfterLine(source, last?.range[1] ?? table.range[1]);
};

const lineDelete = (source: string, range: readonly [number, number]): SourceEdit => ({
  start: lineStart(source, range[0]),
  end: textAfterLine(source, range[1]),
  text: '',
});

const inlineInsert = (container: AST.TOMLInlineTable, key: string, value: ManagedValue): InlineOperation => ({
  kind: 'insert',
  start: container.body.at(-1)?.range[1] ?? container.range[1] - 1,
  text: `${container.body.length > 0 ? ', ' : ''}${encodeTomlKey(key)} = ${encodeTomlValue(value)}`,
});

const standardTableBlock = (
  source: string,
  tables: readonly AST.TOMLTable[],
  table: AST.TOMLTable,
  fields: readonly (readonly [string, ManagedValue])[],
): SourceEdit => {
  const ending = lineEndingFor(source);
  const start = tableInsertionPoint(source, table, tables);
  return {
    start,
    end: start,
    text: `${sourceInsertionPrefix(source, start, ending)}${fieldLines(fields, ending)}`,
  };
};

const newProviderTable = (
  source: string,
  providerId: string,
  fields: readonly (readonly [string, ManagedValue])[],
): SourceEdit => {
  const ending = lineEndingFor(source);
  const prefix = source.length > 0 && !source.endsWith('\n') ? ending : '';
  return {
    start: source.length,
    end: source.length,
    text: `${prefix}[model_providers.${encodeTomlKey(providerId)}]${ending}${fieldLines(fields, ending)}`,
  };
};

const newInlineProvider = (
  container: AST.TOMLInlineTable,
  providerId: string,
  fields: readonly (readonly [string, ManagedValue])[],
): InlineOperation => ({
  kind: 'insert',
  start: container.body.at(-1)?.range[1] ?? container.range[1] - 1,
  text: `${container.body.length > 0 ? ', ' : ''}${encodeTomlKey(providerId)} = { ${fields
    .map(([key, value]) => `${encodeTomlKey(key)} = ${encodeTomlValue(value)}`)
    .join(', ')} }`,
});

const validateFinalDocument = (text: string): void => {
  try {
    Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(
      `Edited Codex configuration is invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export function readManagedField(text: string, path: readonly string[]): ValueSlot {
  const document = inspectDocument(parseDocument(text));
  const value = findValue(document, path);
  return value === undefined ? { present: false } : { present: true, value: managedValue(value) };
}

export function readCodexDocument(text: string): CodexDocument {
  const document = inspectDocument(parseDocument(text));
  const active = findValue(document, ['model_provider']);
  const activeProviderId = active === undefined ? '' : managedValue(active);
  if (typeof activeProviderId !== 'string') throw new Error('model_provider must be a TOML string');
  const providerIds = new Set<string>();
  for (const table of document.tables) {
    const path = table.resolvedKey.map(String);
    if (path.length === 2 && path[0] === 'model_providers') providerIds.add(path[1]!);
  }
  const root = findValue(document, ['model_providers']);
  if (root?.keyValue.value.type === 'TOMLInlineTable') {
    for (const member of root.keyValue.value.body) {
      const parts = keyParts(member.key);
      if (parts.length === 1) providerIds.add(parts[0]!);
    }
  }
  for (const value of document.values) {
    if (
      value.path.length === 2 &&
      value.path[0] === 'model_providers' &&
      value.keyValue.value.type === 'TOMLInlineTable'
    ) {
      providerIds.add(value.path[1]!);
    }
  }
  return { text, activeProviderId, providerIds: [...providerIds] };
}

export function editCodexDocument(text: string, edits: readonly FieldEdit[]): string {
  const document = inspectDocument(parseDocument(text));
  const ending = lineEndingFor(text);
  const sourceEdits: SourceEdit[] = [];
  const inlineOperations = new Map<AST.TOMLInlineTable, InlineOperation[]>();
  const tableFields = new Map<AST.TOMLTable, [string, ManagedValue][]>();
  const topLevelFields: [string, ManagedValue][] = [];
  const newProviders = new Map<string, [string, ManagedValue][]>();
  const newInlineProviders = new Map<
    AST.TOMLInlineTable,
    { readonly providerId: string; readonly fields: [string, ManagedValue][] }
  >();
  const deletedPaths = new Set(edits.filter((edit) => !edit.next.present).map((edit) => edit.path.join('\u0000')));
  const managedProviderFields = new Set([
    'name',
    'base_url',
    'wire_api',
    'requires_openai_auth',
    'experimental_bearer_token',
  ]);
  const providerTableCleanup = new Set(
    document.tables.filter((table) => {
      const tablePath = table.resolvedKey.map(String);
      if (tablePath.length !== 2 || tablePath[0] !== 'model_providers') return false;
      if (table.body.length === 0) return deletedPaths.has(tablePath.join('\u0000'));
      const allFieldsManaged = table.body.every((field) => {
        const fieldPath = [...tablePath, ...keyParts(field.key)];
        return fieldPath.length === 3 && managedProviderFields.has(fieldPath[2]!);
      });
      if (!allFieldsManaged) return false;
      return (
        deletedPaths.has(tablePath.join('\u0000')) ||
        table.body.every((field) => {
          const fieldPath = [...tablePath, ...keyParts(field.key)];
          return (
            fieldPath.length === 3 &&
            managedProviderFields.has(fieldPath[2]!) &&
            deletedPaths.has(fieldPath.join('\u0000'))
          );
        })
      );
    }),
  );

  const addInlineOperation = (container: AST.TOMLInlineTable, operation: InlineOperation): void => {
    const existing = inlineOperations.get(container) ?? [];
    existing.push(operation);
    inlineOperations.set(container, existing);
  };
  const addTableField = (table: AST.TOMLTable, key: string, value: ManagedValue): void => {
    const fields = tableFields.get(table) ?? [];
    fields.push([key, value]);
    tableFields.set(table, fields);
  };

  for (const edit of edits) {
    if (edit.path.length === 0) throw new Error('Managed TOML field path cannot be empty');
    const existing = findValue(document, edit.path);
    if (existing !== undefined) {
      if (!edit.next.present) {
        if (existing.container.type === 'TOMLInlineTable') {
          addInlineOperation(existing.container, inlineMemberDelete(text, existing.container.body, existing.keyValue));
        } else if (existing.container.type === 'TOMLTable' && edit.path.length === 3) {
          if (!providerTableCleanup.has(existing.container))
            sourceEdits.push(lineDelete(text, existing.keyValue.range));
        } else if (edit.path.length === 1 || edit.path[0] !== 'model_providers') {
          sourceEdits.push(lineDelete(text, existing.keyValue.range));
        } else {
          throw new Error('Managed provider table cannot be deleted while preserving unrelated fields');
        }
      } else {
        const oldValue = managedValue(existing);
        if (oldValue !== edit.next.value) {
          const operation: InlineOperation = {
            kind: 'replace',
            start: existing.keyValue.value.range[0],
            end: existing.keyValue.value.range[1],
            text: encodeTomlValue(edit.next.value),
          };
          if (existing.container.type === 'TOMLInlineTable') addInlineOperation(existing.container, operation);
          else sourceEdits.push({ start: operation.start, end: operation.end, text: operation.text });
        }
      }
      continue;
    }
    if (!edit.next.present) {
      if (edit.path.length === 2 && edit.path[0] === 'model_providers') {
        const providerTable = findTable(document, edit.path);
        if (providerTable !== undefined && !providerTableCleanup.has(providerTable)) {
          throw new Error('Managed provider table cannot be deleted while preserving unrelated fields');
        }
      }
      continue;
    }
    const key = edit.path.at(-1)!;
    const parentPath = edit.path.slice(0, -1);
    const parentInline = findInlineContainer(document, parentPath);
    if (parentInline !== undefined) {
      addInlineOperation(parentInline, inlineInsert(parentInline, key, edit.next.value));
      continue;
    }
    if (edit.path.length === 1) {
      topLevelFields.push([key, edit.next.value]);
      continue;
    }
    if (edit.path[0] !== 'model_providers' || edit.path.length !== 3) {
      throw new Error(`Cannot create nested TOML field ${edit.path.join('.')}`);
    }
    const providerId = edit.path[1]!;
    const providerPath = ['model_providers', providerId];
    const providerInline = findInlineContainer(document, providerPath);
    if (providerInline !== undefined) {
      addInlineOperation(providerInline, inlineInsert(providerInline, key, edit.next.value));
      continue;
    }
    const rootInline = findInlineContainer(document, ['model_providers']);
    if (rootInline !== undefined) {
      const existingInline = newInlineProviders.get(rootInline);
      const fields = existingInline?.fields ?? [];
      fields.push([key, edit.next.value]);
      newInlineProviders.set(rootInline, { providerId, fields });
      continue;
    }
    const providerTable = findTable(document, providerPath);
    if (providerTable !== undefined) {
      addTableField(providerTable, key, edit.next.value);
      continue;
    }
    const fields = newProviders.get(providerId) ?? [];
    fields.push([key, edit.next.value]);
    newProviders.set(providerId, fields);
  }

  if (topLevelFields.length > 0) {
    const position = topLevelInsertionPoint(text, document);
    sourceEdits.push({
      start: position,
      end: position,
      text: `${sourceInsertionPrefix(text, position, ending)}${fieldLines(topLevelFields, ending)}`,
    });
  }
  for (const [table, fields] of tableFields) sourceEdits.push(standardTableBlock(text, document.tables, table, fields));
  for (const [providerId, fields] of newProviders) sourceEdits.push(newProviderTable(text, providerId, fields));
  for (const table of providerTableCleanup) {
    const last = table.body.at(-1);
    sourceEdits.push({
      start: lineStart(text, table.range[0]),
      end: textAfterLine(text, last?.range[1] ?? table.range[1]),
      text: '',
    });
  }
  for (const [container, { providerId, fields }] of newInlineProviders) {
    addInlineOperation(container, newInlineProvider(container, providerId, fields));
  }
  for (const [container, operations] of inlineOperations) {
    sourceEdits.push(applyInlineOperations(text, container.range, operations));
  }
  const result = applySourceEdits(text, sourceEdits);
  validateFinalDocument(result);
  return result;
}

export function codexProviderEdits(providerId: string, baseUrl: string, token: string): readonly FieldEdit[] {
  const id = validateCodexProviderId(providerId);
  const fields: Record<string, ManagedValue> = {
    name: 'aio-proxy',
    base_url: baseUrl,
    wire_api: 'responses',
    requires_openai_auth: true,
    experimental_bearer_token: token,
  };
  return [
    { path: ['model_provider'], next: { present: true, value: id } },
    ...Object.entries(fields).map(([key, value]) => ({
      path: ['model_providers', id, key],
      next: { present: true as const, value },
    })),
  ];
}

export function validateCodexProviderId(value: string): string {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  if (hasControlCharacter) throw new Error('Codex provider ID cannot contain control characters');
  const id = value.trim();
  if (id.length === 0) throw new Error('Codex provider ID cannot be empty');
  if (new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock']).has(id)) {
    throw new Error(`Codex provider ID is reserved: ${id}`);
  }
  return id;
}

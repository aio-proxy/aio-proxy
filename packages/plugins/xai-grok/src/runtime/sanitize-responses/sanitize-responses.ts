const DROPPED_FIELDS = [
  'previous_response_id',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
  'stop',
] as const;

type JsonObject = Record<string, unknown>;
type UnionKey = 'anyOf' | 'oneOf';

type ToolCatalogState = {
  readonly kept: Set<string>;
  readonly removed: Set<string>;
};

export function sanitizeXAIGrokResponsesBody(bytes: Uint8Array): Uint8Array {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const body = asRecord(value);
    if (body === undefined) return bytes;
    for (const field of DROPPED_FIELDS) Reflect.deleteProperty(body, field);
    const reasoning = asRecord(body['reasoning']);
    if (reasoning !== undefined) Reflect.deleteProperty(reasoning, 'summary');

    const state: ToolCatalogState = { kept: new Set(), removed: new Set() };
    sanitizeToolList(body['tools'], state);
    if (!Array.isArray(body['tools']) || body['tools'].length === 0) Reflect.deleteProperty(body, 'tools');

    const input = body['input'];
    if (Array.isArray(input)) {
      for (let index = input.length - 1; index >= 0; index -= 1) {
        const item = asRecord(input[index]);
        if (item?.['type'] !== 'additional_tools') continue;
        sanitizeToolList(item['tools'], state);
        if (!Array.isArray(item['tools']) || item['tools'].length === 0) input.splice(index, 1);
      }
    }

    sanitizeToolChoice(body, state);
    return new TextEncoder().encode(JSON.stringify(body));
  } catch {
    return bytes;
  }
}

function toolAliases(name: string, namespace?: string): readonly string[] {
  return namespace === undefined ? [name] : [name, `${namespace}__${name}`];
}

function remember(set: Set<string>, name: unknown, namespace?: string): void {
  if (typeof name !== 'string' || name.length === 0) return;
  for (const alias of toolAliases(name, namespace)) set.add(alias);
}

function sanitizeToolList(tools: unknown, state: ToolCatalogState, namespace?: string): void {
  if (!Array.isArray(tools)) return;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = asRecord(tools[index]);
    if (tool === undefined) continue;
    const type = tool['type'];
    const name = tool['name'];
    if (type === 'namespace') {
      const childNamespace =
        typeof name === 'string' ? (namespace === undefined ? name : `${namespace}__${name}`) : namespace;
      sanitizeToolList(tool['tools'], state, childNamespace);
      if (!Array.isArray(tool['tools']) || tool['tools'].length === 0) tools.splice(index, 1);
      continue;
    }
    if (type !== 'function' || !Object.hasOwn(tool, 'parameters')) {
      remember(state.kept, name, namespace);
      continue;
    }
    const parameters = normalizeXAIToolParameters(tool['parameters']);
    if (parameters === undefined) {
      remember(state.removed, name, namespace);
      tools.splice(index, 1);
      continue;
    }
    tool['parameters'] = parameters;
    remember(state.kept, name, namespace);
  }
}

function wasOnlyRemoved(name: unknown, state: ToolCatalogState): boolean {
  return typeof name === 'string' && state.removed.has(name) && !state.kept.has(name);
}

function hasTools(body: JsonObject): boolean {
  if (Array.isArray(body['tools']) && body['tools'].length > 0) return true;
  const input = body['input'];
  return (
    Array.isArray(input) &&
    input.some((item) => {
      const record = asRecord(item);
      return record?.['type'] === 'additional_tools' && Array.isArray(record['tools']) && record['tools'].length > 0;
    })
  );
}

function resetToolChoice(body: JsonObject): void {
  if (hasTools(body)) body['tool_choice'] = 'auto';
  else Reflect.deleteProperty(body, 'tool_choice');
}

function sanitizeToolChoice(body: JsonObject, state: ToolCatalogState): void {
  const choice = asRecord(body['tool_choice']);
  if (choice === undefined) return;
  const allowed = choice['tools'];
  if (choice['type'] === 'allowed_tools' && Array.isArray(allowed)) {
    const filtered = allowed.filter((entry) => !wasOnlyRemoved(asRecord(entry)?.['name'], state));
    choice['tools'] = filtered;
    if (filtered.length === 0) resetToolChoice(body);
    return;
  }
  if (wasOnlyRemoved(choice['name'], state)) resetToolChoice(body);
}

function normalizeXAIToolParameters(value: unknown): JsonObject | undefined {
  const root = asRecord(value);
  if (root === undefined) return undefined;
  const resolved = resolveLocalRefs(root, root, new Set());
  if (resolved === undefined || Array.isArray(resolved) || asRecord(resolved) === undefined) return undefined;
  const schema = { ...(resolved as JsonObject) };
  Reflect.deleteProperty(schema, '$defs');
  Reflect.deleteProperty(schema, 'definitions');
  Reflect.deleteProperty(schema, '$schema');
  return expandRootObjectUnion(schema);
}

function resolveLocalRefs(value: unknown, root: JsonObject, stack: Set<string>): unknown | undefined {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const resolved = resolveLocalRefs(item, root, stack);
      if (resolved === undefined) return undefined;
      result.push(resolved);
    }
    return result;
  }
  const record = asRecord(value);
  if (record === undefined) return value;

  if (Object.hasOwn(record, '$ref')) {
    const ref = record['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith('#/') || stack.has(ref)) return undefined;
    const target = lookupLocalPointer(root, ref);
    if (target === undefined) return undefined;
    stack.add(ref);
    const resolvedTarget = resolveLocalRefs(target, root, stack);
    stack.delete(ref);
    if (resolvedTarget === undefined) return undefined;

    const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== '$ref'));
    if (Object.keys(siblings).length === 0) return resolvedTarget;
    const resolvedSiblings = resolveLocalRefs(siblings, root, stack);
    if (resolvedSiblings === undefined) return undefined;
    const targetRecord = asRecord(resolvedTarget);
    const siblingRecord = asRecord(resolvedSiblings);
    if (targetRecord === undefined || siblingRecord === undefined) return undefined;
    const targetType = targetRecord['type'];
    const siblingType = siblingRecord['type'];
    if (targetType !== undefined && siblingType !== undefined && targetType !== siblingType) return undefined;
    const type = targetType ?? siblingType;
    return { ...(type === undefined ? {} : { type }), allOf: [targetRecord, siblingRecord] };
  }

  const resolved: JsonObject = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === '$defs' || key === 'definitions') continue;
    const next = resolveLocalRefs(child, root, stack);
    if (next === undefined) return undefined;
    resolved[key] = next;
  }
  return resolved;
}

function lookupLocalPointer(root: JsonObject, ref: string): unknown {
  let current: unknown = root;
  for (const rawToken of ref.slice(2).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (record === undefined || !Object.hasOwn(record, token)) return undefined;
    current = record[token];
  }
  return current;
}

function expandRootObjectUnion(schema: JsonObject): JsonObject | undefined {
  const oneOf = Array.isArray(schema['oneOf']);
  const anyOf = Array.isArray(schema['anyOf']);
  if (oneOf && anyOf) return undefined;
  const key: UnionKey | undefined = oneOf ? 'oneOf' : anyOf ? 'anyOf' : undefined;
  if (key === undefined) return objectBranch(schema);

  const branches = expandObjectBranches(schema[key], key);
  if (branches === undefined) return undefined;
  return { ...schema, type: 'object', [key]: branches };
}

function expandObjectBranches(value: unknown, key: UnionKey): JsonObject[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const expanded: JsonObject[] = [];
  for (const item of value) {
    const branch = asRecord(item);
    if (branch === undefined) return undefined;
    if (Array.isArray(branch[key])) {
      const siblings = Object.fromEntries(Object.entries(branch).filter(([name]) => name !== key));
      const nested = expandObjectBranches(branch[key], key);
      if (nested === undefined) return undefined;
      if (Object.keys(siblings).length === 0) {
        expanded.push(...nested);
        continue;
      }
      const siblingObject = objectBranch(siblings);
      if (siblingObject === undefined) return undefined;
      expanded.push(...nested.map((child) => ({ type: 'object', allOf: [siblingObject, child] })));
      continue;
    }
    const object = objectBranch(branch);
    if (object === undefined) return undefined;
    expanded.push(object);
  }
  return expanded;
}

function objectBranch(schema: JsonObject): JsonObject | undefined {
  const type = schema['type'];
  if (type !== undefined && type !== 'object') return undefined;
  return type === 'object' ? schema : { ...schema, type: 'object' };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

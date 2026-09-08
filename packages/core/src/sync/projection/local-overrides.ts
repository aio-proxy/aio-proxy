import { isPlainObject } from 'es-toolkit/predicate';

import { encode, type JsonValue } from '../protocol';
import type { LocalOverride } from '../repository';

type JsonRecord = Record<string, JsonValue>;

export function cloneJson(value: unknown): JsonValue {
  const bytes = encode(value);
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
}

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== undefined && isPlainObject(value) ? (value as JsonRecord) : undefined;
}

function cloneRecord(value: JsonValue | undefined): JsonRecord {
  const record = asRecord(value);
  return record === undefined ? {} : (cloneJson(record) as JsonRecord);
}

export function mergeJson(left: JsonValue | undefined, right: JsonValue | undefined): JsonValue | undefined {
  if (right === undefined) return left === undefined ? undefined : cloneJson(left);
  const rightRecord = asRecord(right);
  if (rightRecord === undefined) return cloneJson(right);
  const result = cloneRecord(left);
  for (const [key, value] of Object.entries(rightRecord)) {
    result[key] = mergeJson(result[key], value) as JsonValue;
  }
  return result;
}

export function mergeRaw(
  shared: Record<string, JsonValue>,
  local: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return mergeJson(shared, local) as Record<string, JsonValue>;
}

function readPath(root: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (record === undefined || !Object.hasOwn(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

function setPath(root: JsonRecord, path: readonly string[], value: JsonValue): void {
  if (path.length === 0) throw new TypeError('An override path must not be empty');
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isPlainObject(next)) current[segment] = {};
    current = current[segment] as JsonRecord;
  }
  current[path.at(-1)!] = cloneJson(value);
}

function deletePath(root: JsonRecord, path: readonly string[]): void {
  if (path.length === 0) throw new TypeError('An override path must not be empty');
  let current: JsonRecord | undefined = root;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isPlainObject(next)) return;
    current = next as JsonRecord;
  }
  delete current[path.at(-1)!];
}

export function applyOverrides(value: JsonValue, overrides: readonly LocalOverride[]): JsonValue {
  let result = cloneJson(value);
  for (const override of overrides) {
    if (override.value === undefined) {
      if (isPlainObject(result)) deletePath(result as JsonRecord, override.path);
      continue;
    }
    if (!isPlainObject(result)) throw new TypeError('Cannot apply an object override to a non-object entity');
    setPath(result as JsonRecord, override.path, cloneJson(override.value));
  }
  return result;
}

export function applyEntityOverrides(
  root: Record<string, JsonValue>,
  path: readonly string[],
  overrides: readonly LocalOverride[],
): void {
  const current = readPath(root, path);
  if (current === undefined) return;
  const updated = applyOverrides(current, overrides);
  if (path.length === 0) throw new TypeError('An entity root path must not be empty');
  setPath(root, path, updated);
}

export function overlayEntityOverrides(
  root: Record<string, JsonValue>,
  path: readonly string[],
  overrides: readonly LocalOverride[],
): void {
  for (const override of overrides) {
    const fullPath = [...path, ...override.path];
    if (override.value === undefined) deletePath(root, fullPath);
    else setPath(root, fullPath, cloneJson(override.value));
  }
}

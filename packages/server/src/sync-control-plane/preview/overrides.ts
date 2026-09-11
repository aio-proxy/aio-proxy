import type { EntityBody } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { SyncPreviewError } from './errors';

const FORBIDDEN_OVERRIDE =
  /^(?:proxy|credentials?|apiKey|password|backend|connection|account|secret|secrets|plugin|capability|packageName|package|version|objectId|logicalKey|kind|epoch|dependencies|dependency|identity|provider|providerId|accountId)$/iu;

const FORBIDDEN_PROVIDER_REFERENCE = new Set([
  'providerid',
  'providerref',
  'providerrefid',
  'providerreference',
  'providerreferenceid',
  'accountproviderid',
  'accountproviderref',
  'accountproviderrefid',
  'accountproviderreference',
  'accountproviderreferenceid',
]);

function forbiddenOverrideSegment(segment: string): boolean {
  return (
    FORBIDDEN_OVERRIDE.test(segment) ||
    FORBIDDEN_PROVIDER_REFERENCE.has(segment.replaceAll(/[^a-z0-9]/giu, '').toLowerCase())
  );
}

function valueAt(
  value: JsonValue,
  path: readonly string[],
): { readonly value?: JsonValue; readonly traversedArray: boolean } {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (Array.isArray(current)) return { traversedArray: true };
    if (!isPlainObject(current)) return { traversedArray: false };
    current = (current as Record<string, JsonValue>)[segment];
  }
  return { value: current, traversedArray: false };
}

function clone(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function copyValue(value: JsonValue | null): JsonValue | null {
  return value === null ? null : clone(value);
}

export function applyOverrides(local: EntityBody, cloud: EntityBody | null, paths: readonly string[][]): EntityBody {
  const result = copyValue(cloud?.value ?? local.value);
  if (result === null || Array.isArray(result) || !isPlainObject(result)) throw new SyncPreviewError('invalid-request');
  for (const path of paths) {
    if (path.length === 0 || path.some((segment) => segment === '' || forbiddenOverrideSegment(segment)))
      throw new SyncPreviewError('invalid-request');
    const localLookup = valueAt(local.value, path);
    if (localLookup.traversedArray) throw new SyncPreviewError('invalid-request');
    const parentPath = path.slice(0, -1);
    const parentLookup = valueAt(result, parentPath);
    if (parentLookup.traversedArray) throw new SyncPreviewError('invalid-request');
    if (localLookup.value === undefined) {
      if (isPlainObject(parentLookup.value)) delete (parentLookup.value as Record<string, JsonValue>)[path.at(-1)!];
      continue;
    }
    let parent: JsonValue = result;
    for (const segment of parentPath) {
      if (Array.isArray(parent) || !isPlainObject(parent)) throw new SyncPreviewError('invalid-request');
      const record = parent as Record<string, JsonValue>;
      const child = record[segment];
      if (child === undefined) record[segment] = {};
      else if (Array.isArray(child) || !isPlainObject(child)) throw new SyncPreviewError('invalid-request');
      parent = record[segment]!;
    }
    if (!isPlainObject(parent)) throw new SyncPreviewError('invalid-request');
    (parent as Record<string, JsonValue>)[path.at(-1)!] = clone(localLookup.value);
  }
  return { ...local, ...(cloud ?? {}), value: result };
}

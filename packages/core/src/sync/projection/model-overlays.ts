import { isPlainObject } from 'es-toolkit/predicate';

import type { JsonValue } from '../protocol';
import { cloneJson } from './local-overrides';

type JsonRecord = Record<string, JsonValue>;

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== undefined && isPlainObject(value) ? (value as JsonRecord) : undefined;
}

function providerEntries(value: JsonValue | undefined): Record<string, JsonValue> {
  const record = asRecord(value);
  return record === undefined ? {} : record;
}

export function selectedModelPolicy(value: JsonValue, selectedProviders: ReadonlySet<string>): JsonValue {
  const policy = asRecord(value);
  if (policy === undefined) return cloneJson(value);
  const providers = providerEntries(policy['providers']);
  const clonedPolicy = cloneJson(policy) as JsonRecord;
  return {
    ...clonedPolicy,
    providers: Object.fromEntries(Object.entries(providers).filter(([id]) => selectedProviders.has(id))),
  };
}

export function localModelPolicy(value: JsonValue, selectedProviders: ReadonlySet<string>): JsonValue | undefined {
  const policy = asRecord(value);
  if (policy === undefined) return undefined;
  const providers = providerEntries(policy['providers']);
  const excluded = Object.fromEntries(Object.entries(providers).filter(([id]) => !selectedProviders.has(id)));
  return Object.keys(excluded).length === 0 ? undefined : { providers: excluded };
}

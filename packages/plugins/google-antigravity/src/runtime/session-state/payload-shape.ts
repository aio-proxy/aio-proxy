import { isPlainObject } from 'es-toolkit/predicate';
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isPlainObject(value) ? value : undefined;
}

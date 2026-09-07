import { fromBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { isPlainObject } from 'es-toolkit/predicate';

export function appendMcpSnapshot(buffer: string, snapshot: string): string {
  if (!snapshot || buffer.startsWith(snapshot)) return buffer;
  return snapshot.startsWith(buffer) ? snapshot : buffer + snapshot;
}

export function parseMcpObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function mergeMcpObjects(
  prior: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...prior };
  for (const [key, value] of Object.entries(next ?? {})) {
    const previous = merged[key];
    if (typeof value === 'string' && (isPlainObject(previous) || Array.isArray(previous))) continue;
    merged[key] = value;
  }
  return merged;
}

export function declaresNoArguments(schema: unknown): boolean {
  if (!isPlainObject(schema) || schema.type !== 'object') return false;
  if (!isPlainObject(schema.properties) || Object.keys(schema.properties).length !== 0) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) return false;
  return !['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'dependentRequired', 'dependentSchemas'].some(
    (key) => key in schema,
  );
}

export function decodeMcpArgsMap(args: Record<string, Uint8Array> | undefined): Record<string, unknown> | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  const decoded: Record<string, unknown> = {};
  for (const [key, bytes] of Object.entries(args)) decoded[key] = decodeMcpArgValue(bytes);
  return decoded;
}

function decodeMcpArgValue(bytes: Uint8Array): unknown {
  try {
    const json = toJson(ValueSchema, fromBinary(ValueSchema, bytes));
    if (typeof json === 'string') return safeJson(json);
    return json;
  } catch {
    return safeJson(new TextDecoder().decode(bytes));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

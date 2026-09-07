import { fromBinary, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { isPlainObject } from 'es-toolkit/predicate';

export function appendMcpSnapshot(buffer: string, snapshot: string): string {
  if (!snapshot || buffer.startsWith(snapshot)) return buffer;
  return snapshot.startsWith(buffer) ? snapshot : buffer + snapshot;
}

export function incompleteSnapshotOmitsMappedFields(
  buffer: string,
  mapped: Record<string, unknown> | undefined,
): boolean {
  const known = mapped ?? {};
  const text = buffer.trim();
  if (!text.startsWith('{')) return true;
  let i = 1;
  let expectKey = true;
  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    if (i >= text.length) return expectKey;
    const ch = text[i];
    if (ch === '}') return false;
    if (!expectKey) {
      if (ch !== ',') return true;
      i = skipJsonWhitespace(text, i + 1);
      if (i >= text.length) return true;
      expectKey = true;
      continue;
    }
    const key = readJsonString(text, i);
    if (key === undefined) return true;
    i = skipJsonWhitespace(text, key.end);
    if (text[i] !== ':') return true;
    if (!(key.value in known)) return true;
    i = skipJsonWhitespace(text, i + 1);
    if (i >= text.length) return false;
    const valueEnd = skipJsonValue(text, i);
    if (valueEnd === undefined) return false;
    i = valueEnd;
    expectKey = false;
  }
  return expectKey;
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
  if (!isPlainObject(schema) || schema['type'] !== 'object') return false;
  const properties = schema['properties'];
  if (!isPlainObject(properties) || Object.keys(properties).length !== 0) return false;
  const required = schema['required'];
  if (required !== undefined && (!Array.isArray(required) || required.length !== 0)) return false;
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

function skipJsonWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  return i;
}

function readJsonString(text: string, start: number): { value: string; end: number } | undefined {
  if (text[start] !== '"') return undefined;
  let i = start + 1;
  let escape = false;
  while (i < text.length) {
    const ch = text[i];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      i++;
      continue;
    }
    if (ch === '"') {
      try {
        return { value: JSON.parse(text.slice(start, i + 1)) as string, end: i + 1 };
      } catch {
        return undefined;
      }
    }
    i++;
  }
  return undefined;
}

function skipJsonValue(text: string, start: number): number | undefined {
  const ch = text[start];
  if (ch === '"') return readJsonString(text, start)?.end;
  if (ch === '{' || ch === '[') return skipJsonContainer(text, start);
  if (ch === 't' || ch === 'f' || ch === 'n') {
    for (const literal of ['true', 'false', 'null'] as const) {
      if (text.startsWith(literal, start)) return start + literal.length;
      if (literal.startsWith(text.slice(start))) return undefined;
    }
    return undefined;
  }
  if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) return skipJsonNumber(text, start);
  return undefined;
}

function skipJsonContainer(text: string, start: number): number | undefined {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

function skipJsonNumber(text: string, start: number): number | undefined {
  let i = start;
  if (text[i] === '-') i++;
  if (i >= text.length || text[i]! < '0' || text[i]! > '9') return undefined;
  while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
  if (text[i] === '.') {
    i++;
    if (i >= text.length || text[i]! < '0' || text[i]! > '9') return undefined;
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i++;
    if (text[i] === '+' || text[i] === '-') i++;
    if (i >= text.length || text[i]! < '0' || text[i]! > '9') return undefined;
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
  }
  return i;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

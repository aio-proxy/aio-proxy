import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { ValueSlot } from '../config-document';
import type { CodexLocation, CodexMarker, OwnedField } from '../contracts';
import { durableDelete, durableWrite, inspectRegularFile, readRegularFile } from './storage';

const ValueSlotSchema = z.union([
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({
    present: z.literal(true),
    value: z.union([z.string(), z.boolean(), z.number().int().finite(), z.array(z.string())]),
  }),
]);
const OwnedFieldSchema = z.strictObject({
  path: z.array(z.string()).min(1),
  before: ValueSlotSchema,
  applied: ValueSlotSchema,
});
const MarkerBaseSchema = z.strictObject({
  managedBy: z.literal('aio-proxy'),
  configPath: z.string(),
  providerId: z.string().min(1),
  fields: z.array(OwnedFieldSchema),
  createdTables: z.array(z.array(z.string())),
});
const MarkerSchema = z.union([
  MarkerBaseSchema.extend({ format: z.literal(1) }),
  MarkerBaseSchema.extend({
    format: z.literal(2),
    authMode: z.literal('keep-chatgpt'),
  }),
  MarkerBaseSchema.extend({
    format: z.literal(2),
    authMode: z.literal('command'),
    installationId: z.uuid(),
  }),
]);

const ownedProviderFields = new Set([
  'name',
  'base_url',
  'wire_api',
  'requires_openai_auth',
  'experimental_bearer_token',
]);
const ownedCommandFields = new Set(['command', 'args', 'timeout_ms', 'refresh_interval_ms']);

export function validateMarker(value: unknown, location: CodexLocation): CodexMarker {
  const parsed = MarkerSchema.parse(value);
  if (parsed.configPath !== location.configPath) throw new Error('Codex marker config path conflict');
  const isV2 = parsed.format === 2;
  const allowed = new Set([
    'model_provider',
    ...[...ownedProviderFields].map((field) => `model_providers\u0000${parsed.providerId}\u0000${field}`),
    ...(isV2
      ? [...ownedCommandFields].map((field) => `model_providers\u0000${parsed.providerId}\u0000auth\u0000${field}`)
      : []),
  ]);
  const paths = new Set<string>();
  const expectedPaths = new Set([
    'model_provider',
    ...[...ownedProviderFields].map((field) => `model_providers\u0000${parsed.providerId}\u0000${field}`),
    ...(isV2
      ? [...ownedCommandFields].map((field) => `model_providers\u0000${parsed.providerId}\u0000auth\u0000${field}`)
      : []),
  ]);
  if (parsed.fields.length !== expectedPaths.size) throw new Error('Codex marker ownership is incomplete');
  for (const field of parsed.fields) {
    const key = field.path.length === 1 ? field.path[0]! : field.path.join('\u0000');
    if (!allowed.has(key) || paths.has(key)) throw new Error('Codex marker contains an invalid field path');
    paths.add(key);
  }
  if (paths.size !== expectedPaths.size || [...expectedPaths].some((path) => !paths.has(path)))
    throw new Error('Codex marker ownership is incomplete');
  const tableKeys = parsed.createdTables.map((path) => path.join('\u0000'));
  const validTablePath = (path: readonly string[]): boolean =>
    (path.length === 2 && path[0] === 'model_providers' && path[1] === parsed.providerId) ||
    (isV2 && path.length === 3 && path[0] === 'model_providers' && path[1] === parsed.providerId && path[2] === 'auth');
  if (
    parsed.createdTables.length < 1 ||
    new Set(tableKeys).size !== tableKeys.length ||
    parsed.createdTables.some((path) => !validTablePath(path))
  ) {
    throw new Error('Codex marker table ownership is inconsistent');
  }
  return parsed as CodexMarker;
}

export async function readMarker(location: CodexLocation): Promise<CodexMarker | undefined> {
  const stat = await inspectRegularFile(location.markerPath);
  if (stat === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readRegularFile(location.markerPath))!.text);
  } catch {
    throw new Error('Codex marker is invalid');
  }
  if (!isPlainObject(parsed)) throw new Error('Codex marker is invalid');
  try {
    return validateMarker(parsed, location);
  } catch {
    throw new Error('Codex marker is invalid');
  }
}

export async function writeMarker(location: CodexLocation, marker: CodexMarker): Promise<void> {
  validateMarker(marker, location);
  const current = await readRegularFile(location.markerPath);
  await durableWrite(location.markerPath, `${JSON.stringify(marker)}\n`, 0o600, current);
}

export async function deleteMarker(location: CodexLocation): Promise<void> {
  const current = await readRegularFile(location.markerPath);
  await durableDelete(location.markerPath, current);
}

export function appliedProviderBaseUrl(marker: CodexMarker): string | undefined {
  const field = marker.fields.find(
    (item) =>
      item.path.length === 3 &&
      item.path[0] === 'model_providers' &&
      item.path[1] === marker.providerId &&
      item.path[2] === 'base_url',
  );
  return field?.applied.present === true && typeof field.applied.value === 'string' ? field.applied.value : undefined;
}

export function endpointFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/v1\/?$/u, '').replace(/\/+$/u, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/u, '') || undefined;
  } catch {
    return undefined;
  }
}

export async function readAppliedEndpoint(location: CodexLocation): Promise<string | undefined> {
  let marker: CodexMarker | undefined;
  try {
    marker = await readMarker(location);
  } catch {
    return undefined;
  }
  return marker === undefined ? undefined : endpointFromBaseUrl(appliedProviderBaseUrl(marker));
}

export type { ValueSlot, OwnedField };

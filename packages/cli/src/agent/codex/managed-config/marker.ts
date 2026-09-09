import { z } from 'zod';

import type { ValueSlot } from '../config-document';
import type { CodexLocation, CodexMarker, OwnedField } from '../contracts';
import { durableDelete, durableWrite, inspectRegularFile, readRegularFile } from './storage';

const ValueSlotSchema = z.union([
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({ present: z.literal(true), value: z.union([z.string(), z.boolean()]) }),
]);
const OwnedFieldSchema = z.strictObject({
  path: z.array(z.string()).min(1),
  before: ValueSlotSchema,
  applied: ValueSlotSchema,
});
const MarkerSchema = z.strictObject({
  format: z.literal(1),
  managedBy: z.literal('aio-proxy'),
  configPath: z.string(),
  providerId: z.string().min(1),
  fields: z.array(OwnedFieldSchema),
  createdTables: z.array(z.array(z.string())),
});

const ownedProviderFields = new Set([
  'name',
  'base_url',
  'wire_api',
  'requires_openai_auth',
  'experimental_bearer_token',
]);

export function validateMarker(value: unknown, location: CodexLocation): CodexMarker {
  const parsed = MarkerSchema.parse(value);
  if (parsed.configPath !== location.configPath) throw new Error('Codex marker config path conflict');
  const allowed = new Set([
    'model_provider',
    ...[...ownedProviderFields].map((field) => `model_providers\u0000${parsed.providerId}\u0000${field}`),
  ]);
  const paths = new Set<string>();
  const expectedPaths = new Set([
    'model_provider',
    ...[...ownedProviderFields].map((field) => `model_providers\u0000${parsed.providerId}\u0000${field}`),
  ]);
  if (parsed.fields.length !== expectedPaths.size) throw new Error('Codex marker ownership is incomplete');
  for (const field of parsed.fields) {
    const key = field.path.length === 1 ? field.path[0]! : field.path.join('\u0000');
    if (!allowed.has(key) || paths.has(key)) throw new Error('Codex marker contains an invalid field path');
    paths.add(key);
  }
  if (paths.size !== expectedPaths.size || [...expectedPaths].some((path) => !paths.has(path)))
    throw new Error('Codex marker ownership is incomplete');
  if (
    parsed.createdTables.length !== 1 ||
    parsed.createdTables[0]?.length !== 2 ||
    parsed.createdTables[0]?.[0] !== 'model_providers' ||
    parsed.createdTables[0]?.[1] !== parsed.providerId
  ) {
    throw new Error('Codex marker table ownership is inconsistent');
  }
  for (const path of parsed.createdTables) {
    if (path.length !== 2 || path[0] !== 'model_providers' || path[1] !== parsed.providerId)
      throw new Error('Codex marker contains an invalid table path');
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

export type { ValueSlot, OwnedField };

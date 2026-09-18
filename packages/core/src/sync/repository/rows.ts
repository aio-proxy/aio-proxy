import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { z } from 'zod';

import type { OAuthOwnership } from '../oauth';
import type { EntityBody, EntityKind } from '../protocol';
import type {
  CommitIntent,
  LocalEntity,
  LocalOverride,
  OAuthJournalRow,
  OutboxOperation,
  PluginSecretCommit,
} from './repository';

const jsonValueSchema = z.json() as z.ZodType<JsonValue>;

const dependencySchema = z.object({ objectId: z.string(), packageName: z.string(), version: z.string() });
const entityKindSchema = z.enum(['provider', 'model-rule', 'plugin-business', 'service-access', 'routing-defaults']);
const entityBodySchema = z.object({
  kind: z.enum(['provider', 'model-rule', 'plugin-business', 'service-access', 'routing-defaults']),
  logicalKey: z.string(),
  value: jsonValueSchema,
  dependencies: z.array(dependencySchema),
});
const overrideSchema = z.object({ path: z.array(z.string()), value: jsonValueSchema.optional() });
const remoteOperationSchema = z.object({ objectId: z.string(), operationId: z.string() });
const sourceRevisionsSchema = z.record(z.string(), z.number().int().nonnegative());
const pluginSecretCommitSchema = z.object({
  plugin: z.string(),
  before: jsonValueSchema.optional(),
  after: jsonValueSchema.optional(),
});
const oauthOwnershipSchema: z.ZodType<OAuthOwnership> = z.object({
  mode: z.enum(['shared', 'share-pending', 'detach-pending', 'independent']),
  epoch: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  localRevision: z.number().int().nonnegative(),
  pluginVersion: z.string(),
  formatVersion: z.number().int().positive(),
  multiDeviceEvidenceId: z.string().optional(),
});

export function stringifyJson(value: JsonValue): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Expected a JSON value');
  return encoded;
}

export function parseJson<T>(value: unknown, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new TypeError('Invalid JSON in sync repository row');
  }
  return schema.parse(decoded);
}

export function parseJsonValue(value: unknown): JsonValue {
  return parseJson(value, jsonValueSchema);
}

export function parseEntityBody(value: unknown): EntityBody {
  return parseJson(value, entityBodySchema) as EntityBody;
}

export function parseEntityBodyOrNull(value: unknown): EntityBody | null {
  return value === null ? null : parseEntityBody(value);
}

export function parseOverrides(value: unknown): LocalOverride[] {
  return parseJson(value, z.array(overrideSchema)).map((override): LocalOverride => ({
    path: override.path,
    value: override.value,
  }));
}

export function parseStringArray(value: unknown): string[] {
  return parseJson(value, z.array(z.string()));
}

export function parseRemoteOperations(value: unknown): { objectId: string; operationId: string }[] | undefined {
  return value === null ? undefined : parseJson(value, z.array(remoteOperationSchema));
}

export function parseSourceRevisions(value: unknown): Record<string, number> | undefined {
  return value === null ? undefined : parseJson(value, sourceRevisionsSchema);
}

export function parsePluginSecrets(value: unknown): PluginSecretCommit[] | undefined {
  return value === null ? undefined : parseJson(value, z.array(pluginSecretCommitSchema));
}

export function parseEntityRow(row: {
  object_id: string;
  logical_key: string;
  kind: string;
  mode: string;
  epoch: number;
  desired_json: unknown;
  baseline: string | null;
  overrides_json: unknown;
  pending_reason: string | null;
  oauth_json?: unknown;
}): LocalEntity {
  return {
    objectId: row.object_id,
    logicalKey: row.logical_key,
    kind: entityKindSchema.parse(row.kind) as EntityKind,
    mode: z.enum(['included', 'excluded']).parse(row.mode) as LocalEntity['mode'],
    epoch: z.number().int().nonnegative().parse(row.epoch),
    desired: parseEntityBodyOrNull(row.desired_json),
    baseline: row.baseline,
    overrides: parseOverrides(row.overrides_json),
    pendingReason: row.pending_reason,
    ...(row.oauth_json === undefined || row.oauth_json === null
      ? {}
      : { oauth: parseJson(row.oauth_json, oauthOwnershipSchema) }),
  };
}

export function parseOutboxRow(row: {
  operation_id: string;
  object_id: string;
  epoch: number;
  kind: string;
  body_json: unknown;
  commit_id: string;
}): OutboxOperation {
  return {
    operationId: row.operation_id,
    objectId: row.object_id,
    epoch: z.number().int().nonnegative().parse(row.epoch),
    kind: z.enum(['put', 'delete']).parse(row.kind) as OutboxOperation['kind'],
    body: parseEntityBodyOrNull(row.body_json),
    commitId: row.commit_id,
  };
}

export function parseCommitRow(row: {
  commit_id: string;
  origin: string;
  before_digest: string;
  after_digest: string;
  raw_after_json: unknown;
  account_operation_ids_json: unknown;
  phase: string;
  remote_operations_json: unknown;
  plugin_secrets_json: unknown;
  source_revisions_json: unknown;
}): CommitIntent {
  return {
    commitId: row.commit_id,
    origin: z.enum(['local', 'remote']).parse(row.origin) as CommitIntent['origin'],
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
    rawAfter: parseJsonValue(row.raw_after_json),
    accountOperationIds: parseStringArray(row.account_operation_ids_json),
    phase: z.enum(['prepared', 'confirmed']).parse(row.phase) as CommitIntent['phase'],
    remoteOperations: parseRemoteOperations(row.remote_operations_json),
    pluginSecrets: parsePluginSecrets(row.plugin_secrets_json),
    sourceRevisions: parseSourceRevisions(row.source_revisions_json),
  };
}

export function parseOAuthJournalRow(row: {
  operation_id: string;
  object_id: string;
  epoch: number;
  base_generation: number;
  phase: string;
  payload_json: unknown;
}): OAuthJournalRow {
  return {
    operationId: row.operation_id,
    objectId: row.object_id,
    epoch: z.number().int().nonnegative().parse(row.epoch),
    baseGeneration: z.number().int().nonnegative().parse(row.base_generation),
    phase: z.enum(['started', 'result', 'complete']).parse(row.phase) as OAuthJournalRow['phase'],
    payload: row.payload_json === null ? null : parseJsonValue(row.payload_json),
  };
}

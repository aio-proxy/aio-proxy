import { randomBytes } from 'node:crypto';

import {
  decodeHead,
  decodeRevision,
  entityKey,
  revisionKey,
  type EntityBody,
  type LocalBinding,
  type LocalEntity,
  type SyncRepository,
} from '@aio-proxy/core';
import type { JsonValue, SyncSession } from '@aio-proxy/plugin-sdk';
import type { SyncPreview, SyncPreviewInput, SyncPreviewRow } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

export type RemoteEntity = {
  readonly objectId: string;
  readonly logicalKey: string;
  readonly kind: string;
  readonly version: string | null;
  readonly body: EntityBody | null;
  readonly tombstone?: boolean;
};

export type PreviewFence = {
  readonly bindingId: string;
  readonly sessionGeneration: number;
  readonly localCommitId: string;
  readonly rangeRevision: number;
  readonly remoteVersions: Record<string, string | null>;
};

export type PreviewRecord = {
  readonly fence: PreviewFence;
  readonly input: SyncPreviewInput;
  readonly rows: readonly PreviewCandidate[];
  readonly expiresAt: number;
};

export type PreviewCandidate = {
  readonly row: SyncPreviewRow;
  readonly local: EntityBody | null;
  readonly cloud: EntityBody | null;
  readonly requiresProviderId?: boolean;
};

export class SyncPreviewError extends Error {
  override readonly name = 'SyncPreviewError';
  constructor(readonly code: 'preview-stale' | 'not-connected') {
    super(code);
  }
}

const SECRET_KEY = /(?:secret|password|passwd|token|credential|api[-_]?key|refresh|access[-_]?key)/iu;

function clone(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function redact(value: JsonValue, key = '', secretKeys: ReadonlySet<string> = new Set()): JsonValue {
  if (SECRET_KEY.test(key) || secretKeys.has(key)) return '[redacted]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, '', secretKeys)) as JsonValue;
  const result: Record<string, JsonValue> = {};
  for (const [childKey, entry] of Object.entries(value)) result[childKey] = redact(entry, childKey, secretKeys);
  return result;
}

function sensitive(value: JsonValue | null, secretKeys: ReadonlySet<string> = new Set()): Record<string, JsonValue> {
  const found: Record<string, JsonValue> = {};
  const visit = (entry: JsonValue, path: string): void => {
    if (entry === null || typeof entry !== 'object') {
      if (SECRET_KEY.test(path) || secretKeys.has(path) || secretKeys.has(path.split('.').at(-1) ?? ''))
        found[path] = entry;
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(entry)) visit(child, path === '' ? key : `${path}.${key}`);
  };
  if (value !== null) visit(value, '');
  return found;
}

export function secretChange(
  local: JsonValue | null,
  cloud: JsonValue | null,
  secretKeys?: ReadonlySet<string>,
): SyncPreviewRow['secretChange'] {
  const left = sensitive(local, secretKeys);
  const right = sensitive(cloud, secretKeys);
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length === 0 && rightKeys.length === 0) return 'none';
  if (leftKeys.length === 0) return 'added';
  if (rightKeys.length === 0) return 'removed';
  return JSON.stringify(left) === JSON.stringify(right) ? 'none' : 'changed';
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rowFor(
  local: EntityBody | null,
  cloud: EntityBody | null,
  objectId: string,
  remote?: RemoteEntity,
  secretKeys?: ReadonlySet<string>,
): PreviewCandidate {
  const source = local ?? cloud;
  const change =
    local === null && cloud !== null
      ? 'add'
      : local !== null && cloud === null
        ? remote?.tombstone === true
          ? 'delete'
          : 'add'
        : equal(local, cloud)
          ? 'update'
          : 'conflict';
  const choices: SyncPreviewRow['choices'] =
    change === 'delete'
      ? ['restore']
      : change === 'conflict'
        ? ['local', 'cloud', 'restore']
        : local === null
          ? ['cloud']
          : cloud === null
            ? ['local']
            : ['local', 'cloud'];
  return {
    local,
    cloud,
    row: {
      objectId,
      logicalKey: source?.logicalKey ?? remote?.logicalKey ?? objectId,
      kind: source?.kind ?? remote?.kind ?? 'provider',
      change,
      local: local === null ? null : (redact(clone(local.value), '', secretKeys) as SyncPreviewRow['local']),
      cloud: cloud === null ? null : (redact(clone(cloud.value), '', secretKeys) as SyncPreviewRow['cloud']),
      secretChange: secretChange(local?.value ?? null, cloud?.value ?? null, secretKeys),
      dependencies: [
        ...new Set([...(local?.dependencies ?? []), ...(cloud?.dependencies ?? [])].map((d) => d.objectId)),
      ],
      choices,
    },
  };
}

export function sameFence(a: PreviewFence, b: PreviewFence): boolean {
  return (
    a.bindingId === b.bindingId &&
    a.sessionGeneration === b.sessionGeneration &&
    a.localCommitId === b.localCommitId &&
    a.rangeRevision === b.rangeRevision &&
    JSON.stringify(Object.entries(a.remoteVersions).sort()) === JSON.stringify(Object.entries(b.remoteVersions).sort())
  );
}

export function createPreviewToken(bytes = 24, source: (size: number) => Uint8Array = randomBytes): string {
  return Buffer.from(source(bytes)).toString('base64url');
}

export async function listRemoteEntities(session: SyncSession | undefined): Promise<RemoteEntity[]> {
  if (session === undefined) return [];
  const signal = new AbortController().signal;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.list(
      { prefix: 's/v1/default/entity/', ...(cursor === undefined ? {} : { cursor }) },
      signal,
    );
    keys.push(...page.keys);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const result: RemoteEntity[] = [];
  for (const key of keys) {
    const objectId = key.slice('s/v1/default/entity/'.length);
    if (objectId === '') continue;
    const value = await session.read(entityKey(objectId), signal);
    if (value.kind === 'absent') continue;
    const head = decodeHead(value.value);
    let body: EntityBody | null = null;
    if (head.current !== null) {
      const revision = await session.read(revisionKey(objectId, head.current), signal);
      if (revision.kind !== 'absent') {
        const record = decodeRevision(revision.value);
        if (record.state === 'payload') body = record.body;
      }
    }
    result.push({
      objectId,
      logicalKey: head.logicalKey,
      kind: head.kind,
      version: value.version,
      body,
      tombstone: head.state === 'deleted' || head.state === 'purged',
    });
  }
  return result;
}

export function buildPreview(input: {
  readonly request: SyncPreviewInput;
  readonly local: readonly LocalEntity[];
  readonly remote: readonly RemoteEntity[];
  readonly fence: PreviewFence;
  readonly previewId: string;
  readonly expiresAt: number;
  readonly secretKeys?: ReadonlySet<string>;
}): { readonly preview: SyncPreview; readonly record: PreviewRecord } {
  const localByObject = new Map(input.local.map((entity) => [entity.objectId, entity]));
  const remoteByObject = new Map(input.remote.map((entity) => [entity.objectId, entity]));
  const ids = new Set<string>();
  if (input.request.kind === 'join') {
    for (const entity of input.local) if (entity.logicalKey === input.request.providerId) ids.add(entity.objectId);
    for (const entity of input.remote) if (entity.logicalKey === input.request.providerId) ids.add(entity.objectId);
  } else if (input.request.kind === 'restore' || input.request.kind === 'overrides') ids.add(input.request.objectId);
  else if (input.request.kind === 'purge') {
    for (const entity of input.local)
      if (
        input.request.scope === 'provider'
          ? entity.logicalKey === input.request.objectId
          : entity.objectId === input.request.objectId
      )
        ids.add(entity.objectId);
    for (const entity of input.remote)
      if (
        input.request.scope === 'provider'
          ? entity.logicalKey === input.request.objectId
          : entity.objectId === input.request.objectId
      )
        ids.add(entity.objectId);
  } else for (const id of [...localByObject.keys(), ...remoteByObject.keys()]) ids.add(id);
  const identityGroups = new Map<string, Set<string>>();
  for (const entity of [...input.local, ...input.remote]) {
    const groupKey = `${entity.kind}\0${entity.logicalKey}`;
    const idsForKey = identityGroups.get(groupKey) ?? new Set<string>();
    idsForKey.add(entity.objectId);
    identityGroups.set(groupKey, idsForKey);
  }
  const identityConflictKeys = new Set(
    [...identityGroups].filter(([, objectIds]) => objectIds.size > 1).map(([groupKey]) => groupKey),
  );
  const candidates = [...ids]
    .map((objectId) =>
      rowFor(
        localByObject.get(objectId)?.desired ?? null,
        remoteByObject.get(objectId)?.body ?? null,
        objectId,
        remoteByObject.get(objectId),
        input.secretKeys,
      ),
    )
    .map((candidate) => {
      if (!identityConflictKeys.has(`${candidate.row.kind}\0${candidate.row.logicalKey}`)) return candidate;
      return {
        ...candidate,
        requiresProviderId: true,
        row: {
          ...candidate.row,
          change: 'conflict' as const,
          choices: ['local', 'cloud', 'restore'] as SyncPreviewRow['choices'],
        },
      };
    });
  const retainedSharedPlugins =
    input.request.kind === 'purge'
      ? [
          ...new Set(
            input.local
              .filter((entity) => entity.kind === 'plugin-business' && !ids.has(entity.objectId))
              .map((entity) => entity.logicalKey),
          ),
        ]
      : [];
  const preview: SyncPreview = {
    previewId: input.previewId,
    kind: input.request.kind,
    rows: candidates.map((candidate) => candidate.row),
    retainedSharedPlugins,
    expiresAt: input.expiresAt,
  };
  return {
    preview,
    record: { fence: input.fence, input: input.request, rows: candidates, expiresAt: input.expiresAt },
  };
}

export function latestCommitId(repo: SyncRepository, binding: LocalBinding): string {
  const latest = (repo as Partial<SyncRepository>).latestConfirmedCommit;
  return latest === undefined ? '' : (latest(binding.id)?.commitId ?? '');
}

export function objectValue(value: unknown): Record<string, JsonValue> {
  return isPlainObject(value) ? (value as Record<string, JsonValue>) : {};
}

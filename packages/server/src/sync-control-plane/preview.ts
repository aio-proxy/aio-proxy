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
  type PluginRepository,
  type PluginRegistry,
} from '@aio-proxy/core';
import type { JsonValue, SyncSession } from '@aio-proxy/plugin-sdk';
import type { SyncPreview, SyncPreviewInput, SyncPreviewRow } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { SyncPreviewError } from './preview-errors';
import { applyOverrides } from './preview-overrides';

export { SyncPreviewError } from './preview-errors';
export { applyOverrides } from './preview-overrides';

export type RemoteEntity = {
  readonly objectId: string;
  readonly logicalKey: string;
  readonly kind: string;
  readonly version: string | null;
  /** Current protocol revision operation ID; this is the sync baseline identity. */
  readonly revision: string | null;
  readonly body: EntityBody | null;
  readonly tombstone?: boolean;
  readonly revisions?: Readonly<Record<string, EntityBody | null>>;
  readonly restoreBody?: EntityBody | null;
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
  readonly local: readonly LocalEntity[];
  readonly remote: readonly RemoteEntity[];
  readonly rows: readonly PreviewCandidate[];
  readonly expiresAt: number;
  readonly dependencyError?: boolean;
};

export type PreviewCandidate = {
  readonly row: SyncPreviewRow;
  readonly local: EntityBody | null;
  readonly cloud: EntityBody | null;
  readonly restoreBody?: EntityBody | null;
  readonly requiresProviderId?: boolean;
};

function snapshotBody(body: EntityBody | null | undefined): EntityBody | null | undefined {
  if (body === null || body === undefined) return body;
  return {
    ...body,
    value: clone(body.value),
    dependencies: body.dependencies.map((dependency) => ({ ...dependency })),
  };
}

export function snapshotRemoteEntities(remote: readonly RemoteEntity[]): RemoteEntity[] {
  return remote.map((entity) => ({
    ...entity,
    version: entity.version,
    revision: entity.revision,
    body: snapshotBody(entity.body) ?? null,
    revisions:
      entity.revisions === undefined
        ? undefined
        : Object.fromEntries(Object.entries(entity.revisions).map(([id, body]) => [id, snapshotBody(body) ?? null])),
    restoreBody: snapshotBody(entity.restoreBody),
  }));
}

export function snapshotLocalEntities(local: readonly LocalEntity[]): LocalEntity[] {
  return local.map((entity) => ({
    ...entity,
    desired: snapshotBody(entity.desired) ?? null,
    overrides: entity.overrides.map((override) => ({
      ...override,
      ...(override.value === undefined ? {} : { value: clone(override.value) }),
    })),
    oauth: entity.oauth === undefined ? undefined : { ...entity.oauth },
  }));
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

function redactEntityValue(body: EntityBody, secretKeys: ReadonlySet<string>): JsonValue {
  const wholeRecord = body.kind === 'plugin-business' && /(?:secret|credential)/iu.test(body.logicalKey);
  if (wholeRecord) return '[redacted]';
  const redactRecord = (value: JsonValue, key = ''): JsonValue => {
    if (/^(?:account|credential|credentials|secret|secrets|pluginSecret|pluginSecrets)$/iu.test(key))
      return '[redacted]';
    return redact(value, key, secretKeys);
  };
  return redactRecord(clone(body.value));
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
  const safeKeys = secretKeys ?? new Set<string>();
  const left = sensitive(local, safeKeys);
  const right = sensitive(cloud, safeKeys);
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
  redactedLocal?: JsonValue | null,
  redactedCloud?: JsonValue | null,
): PreviewCandidate {
  const safeSecretKeys = secretKeys ?? new Set<string>();
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
    restoreBody: remote?.restoreBody,
    row: {
      objectId,
      logicalKey: source?.logicalKey ?? remote?.logicalKey ?? objectId,
      kind: source?.kind ?? remote?.kind ?? 'provider',
      change,
      local:
        local === null
          ? null
          : ((redactedLocal ?? redactEntityValue(local, safeSecretKeys)) as SyncPreviewRow['local']),
      cloud:
        cloud === null
          ? null
          : ((redactedCloud ?? redactEntityValue(cloud, safeSecretKeys)) as SyncPreviewRow['cloud']),
      secretChange: secretChange(local?.value ?? null, cloud?.value ?? null, safeSecretKeys),
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
    if (head.objectId !== objectId) throw new SyncPreviewError('not-connected');
    if (head.state === 'purging') throw new SyncPreviewError('not-connected');
    let body: EntityBody | null = null;
    const revisions: Record<string, EntityBody | null> = {};
    for (const operationId of [...new Set([...head.history, ...(head.current === null ? [] : [head.current])])]) {
      const revision = await session.read(revisionKey(objectId, operationId), signal);
      if (revision.kind === 'absent') continue;
      const record = decodeRevision(revision.value);
      if (record.objectId !== objectId) throw new SyncPreviewError('not-connected');
      if (record.state === 'payload') {
        if (record.body.kind !== head.kind || record.body.logicalKey !== head.logicalKey)
          throw new SyncPreviewError('not-connected');
        revisions[operationId] = record.body;
      } else revisions[operationId] = null;
    }
    if (head.current !== null) {
      body = revisions[head.current] ?? null;
    }
    result.push({
      objectId,
      logicalKey: head.logicalKey,
      kind: head.kind,
      version: value.version,
      revision: head.current,
      body,
      tombstone: head.state === 'deleted' || head.state === 'purged',
      revisions,
      restoreBody:
        body ?? [...Object.values(revisions)].reverse().find((revision): revision is EntityBody => revision !== null),
    });
  }
  return result;
}

// eslint-disable-next-line max-lines-per-function -- preview assembly keeps one immutable snapshot for the fence
export function buildPreview(input: {
  readonly request: SyncPreviewInput;
  readonly local: readonly LocalEntity[];
  readonly remote: readonly RemoteEntity[];
  readonly fence: PreviewFence;
  readonly previewId: string;
  readonly expiresAt: number;
  readonly registry?: PluginRegistry;
  readonly accounts?: PluginRepository;
}): { readonly preview: SyncPreview; readonly record: PreviewRecord } {
  const localSnapshot = snapshotLocalEntities(input.local);
  const remoteSnapshot = snapshotRemoteEntities(input.remote);
  const localByObject = new Map(localSnapshot.map((entity) => [entity.objectId, entity]));
  const remoteByObject = new Map(remoteSnapshot.map((entity) => [entity.objectId, entity]));
  const ids = new Set<string>();
  if (input.request.kind === 'join') {
    for (const entity of localSnapshot) if (entity.logicalKey === input.request.providerId) ids.add(entity.objectId);
    for (const entity of remoteSnapshot) if (entity.logicalKey === input.request.providerId) ids.add(entity.objectId);
  } else if (input.request.kind === 'restore' || input.request.kind === 'overrides') ids.add(input.request.objectId);
  else if (input.request.kind === 'purge') {
    const purge = input.request;
    const remoteIds = new Set(remoteSnapshot.map((entity) => entity.objectId));
    const all = [
      ...localSnapshot.map((entity) => ({
        objectId: entity.objectId,
        logicalKey: entity.logicalKey,
        kind: entity.kind,
        remote: false,
        dependencies: entity.desired?.dependencies ?? [],
      })),
      ...remoteSnapshot.map((entity) => ({
        objectId: entity.objectId,
        logicalKey: entity.logicalKey,
        kind: entity.kind,
        remote: true,
        dependencies: entity.body?.dependencies ?? [],
      })),
    ];
    const targets = new Set(
      all
        .filter((entity) =>
          purge.scope === 'provider'
            ? entity.kind === 'provider' && entity.logicalKey === purge.objectId
            : entity.kind === 'plugin-business' && entity.logicalKey === purge.objectId,
        )
        .map((entity) => entity.objectId),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const entity of all) {
        if (entity.remote && entity.dependencies.some((dependency) => targets.has(dependency.objectId))) {
          if (!targets.has(entity.objectId)) {
            targets.add(entity.objectId);
            changed = true;
          }
        }
      }
    }
    for (const objectId of targets) if (remoteIds.has(objectId)) ids.add(objectId);
  } else for (const id of [...localByObject.keys(), ...remoteByObject.keys()]) ids.add(id);
  const identityGroups = new Map<string, Set<string>>();
  for (const entity of [...localSnapshot, ...remoteSnapshot]) {
    const groupKey = `${entity.kind}\0${entity.logicalKey}`;
    const idsForKey = identityGroups.get(groupKey) ?? new Set<string>();
    idsForKey.add(entity.objectId);
    identityGroups.set(groupKey, idsForKey);
  }
  const identityConflictKeys = new Set(
    [...identityGroups].filter(([, objectIds]) => objectIds.size > 1).map(([groupKey]) => groupKey),
  );
  const candidateIds =
    input.request.kind === 'purge' ? [...ids].filter((objectId) => remoteByObject.has(objectId)) : [...ids];
  const candidates = candidateIds
    .map((objectId) =>
      (() => {
        const local = localByObject.get(objectId)?.desired ?? null;
        const remoteEntity = remoteByObject.get(objectId);
        let remote: EntityBody | null;
        if (input.request.kind === 'restore') {
          const restored = remoteEntity?.revisions?.[input.request.operationId];
          if (restored === undefined) throw new SyncPreviewError('not-connected');
          remote = restored;
        } else remote = remoteEntity?.body ?? null;
        if (input.request.kind === 'overrides' && local !== null)
          remote = applyOverrides(local, remote, input.request.paths);
        const secretKeys = new Set<string>();
        for (const body of [local, remote]) {
          if (body?.kind !== 'provider' || !isPlainObject(body.value) || input.registry === undefined) continue;
          const value = body.value as Record<string, JsonValue>;
          const plugin = value['plugin'];
          const capability = value['capability'];
          if (typeof plugin !== 'string' || typeof capability !== 'string') continue;
          const adapter = input.registry.resolveOAuth(plugin, capability);
          if (adapter === undefined) continue;
          for (const field of adapter.account.options.form) if (field.type === 'secret') secretKeys.add(field.key);
        }
        return rowFor(
          local,
          remote,
          objectId,
          remoteEntity,
          secretKeys,
          local === null ? null : redactEntityValue(local, secretKeys),
          remote === null ? null : redactEntityValue(remote, secretKeys),
        );
      })(),
    )
    .map((candidate) => {
      if (input.request.kind === 'purge') return candidate;
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
            localSnapshot
              .filter((entity) => entity.kind === 'plugin-business' && !ids.has(entity.objectId))
              .map((entity) => entity.logicalKey),
          ),
        ]
      : [];
  const allRemoteIds = new Set(remoteSnapshot.map((entity) => entity.objectId));
  const allLocalIds = new Set(localSnapshot.map((entity) => entity.objectId));
  const dependencyError =
    input.request.kind === 'purge' &&
    candidates.some(
      (candidate) =>
        remoteByObject
          .get(candidate.row.objectId)
          ?.body?.dependencies.some(
            (dependency) => !allRemoteIds.has(dependency.objectId) && !allLocalIds.has(dependency.objectId),
          ) ?? false,
    );
  const preview: SyncPreview = {
    previewId: input.previewId,
    kind: input.request.kind,
    rows: candidates.map((candidate) => candidate.row),
    retainedSharedPlugins,
    expiresAt: input.expiresAt,
  };
  return {
    preview,
    record: {
      fence: input.fence,
      input: input.request,
      local: localSnapshot,
      remote: remoteSnapshot,
      rows: candidates,
      expiresAt: input.expiresAt,
      dependencyError,
    },
  };
}

export function latestCommitId(repo: SyncRepository, binding: LocalBinding): string {
  const latest = (repo as Partial<SyncRepository>).latestConfirmedCommit;
  return latest === undefined ? '' : (latest(binding.id)?.commitId ?? '');
}

export function objectValue(value: unknown): Record<string, JsonValue> {
  return isPlainObject(value) ? (value as Record<string, JsonValue>) : {};
}

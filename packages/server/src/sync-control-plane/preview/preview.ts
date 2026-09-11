import { randomBytes } from 'node:crypto';

import {
  projectCommitted,
  providerDependencyPackage,
  type CommittedSource,
  type EntityBody,
  type LocalBinding,
  type LocalEntity,
  type SyncRepository,
  type PluginRepository,
  type PluginRegistry,
} from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncPreview, SyncPreviewInput, SyncPreviewRow } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { snapshotLocalEntities, snapshotRemoteEntities, type RemoteEntity } from './entities';
import { SyncPreviewError } from './errors';
import { applyOverrides } from './overrides';
import { redactEntityValue, secretChange } from './redact';

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

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// A tombstoned entity reports no live body, but its last payload still names the objects it linked
// to; dependency traversal has to see them so a rejoin or purge covers the whole graph.
function remoteDependencies(entity: RemoteEntity | undefined): readonly { readonly objectId: string }[] {
  return entity?.body?.dependencies ?? entity?.restoreBody?.dependencies ?? [];
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
  readonly source?: CommittedSource;
}): { readonly preview: SyncPreview; readonly record: PreviewRecord } {
  const localSnapshot = snapshotLocalEntities(input.local);
  const remoteSnapshot = snapshotRemoteEntities(input.remote);
  const localByObject = new Map(localSnapshot.map((entity) => [entity.objectId, entity]));
  const remoteByObject = new Map(remoteSnapshot.map((entity) => [entity.objectId, entity]));
  const ids = new Set<string>();
  if (input.request.kind === 'join') {
    // `providerId` is the logical key of any kind, not only a Provider: a model rule is joined the
    // same way.
    const providerId = input.request.providerId;
    for (const entity of localSnapshot) if (entity.logicalKey === providerId) ids.add(entity.objectId);
    for (const entity of remoteSnapshot) if (entity.logicalKey === providerId) ids.add(entity.objectId);
    // A Provider is only publishable together with the business plugin config it needs, so the
    // join has to carry that object too. The authored configuration is the only source for it
    // while the Provider itself is still local-only and therefore has no published body yet.
    const dependency = input.source === undefined ? undefined : providerDependencyPackage(input.source.raw, providerId);
    if (dependency !== undefined) {
      for (const entity of [...localSnapshot, ...remoteSnapshot])
        if (entity.kind === 'plugin-business' && entity.logicalKey === dependency) ids.add(entity.objectId);
    }
    // Anything already published names its dependencies directly; follow them to their fixed point
    // so a rejoin never leaves a selected object pointing at an unselected one.
    const dependenciesOf = (objectId: string): readonly string[] => [
      ...(localByObject.get(objectId)?.desired?.dependencies ?? []).map((d) => d.objectId),
      ...remoteDependencies(remoteByObject.get(objectId)).map((d) => d.objectId),
    ];
    for (let changed = true; changed;) {
      changed = false;
      for (const objectId of [...ids])
        for (const dependent of dependenciesOf(objectId))
          if (!ids.has(dependent)) {
            ids.add(dependent);
            changed = true;
          }
    }
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
        dependencies: remoteDependencies(entity),
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
  // A tombstoned remote head no longer claims its identity. Counting it would report a collision
  // against the one live object that remains and, for a Provider, demand a replacement Provider ID
  // to resolve a duplicate that has already been deleted or purged.
  for (const entity of [...localSnapshot, ...remoteSnapshot.filter((entity) => entity.tombstone !== true)]) {
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
  // A local-only object has no published body, so its stored `desired` is null and the join would
  // preview and publish nothing. Project the authored configuration as if the selected set were
  // already included: that yields the exact bodies applying the local choice will publish,
  // dependencies included, and reuses the one projection the commit path uses rather than a second
  // encoding. An override pins a path of that same authored body, so it needs the projection too —
  // reading the published body there would pin `undefined` and delete the value locally. An
  // override previews one object, so its business plugin is projected without becoming a row: the
  // projection drops a Provider whose dependency is not included, and that would leave no body.
  const projected = new Set(ids);
  if (input.request.kind === 'overrides' && input.source !== undefined) {
    const logicalKey = localByObject.get(input.request.objectId)?.logicalKey;
    const dependency = logicalKey === undefined ? undefined : providerDependencyPackage(input.source.raw, logicalKey);
    for (const entity of localSnapshot)
      if (entity.kind === 'plugin-business' && entity.logicalKey === dependency) projected.add(entity.objectId);
  }
  const joined =
    (input.request.kind !== 'join' && input.request.kind !== 'overrides') || input.source === undefined
      ? undefined
      : projectCommitted(
          input.source,
          localSnapshot.map((entity) =>
            projected.has(entity.objectId) ? { ...entity, mode: 'included' as const } : entity,
          ),
        ).entities;
  const candidates = candidateIds
    .map((objectId) =>
      (() => {
        const local = joined?.get(objectId) ?? localByObject.get(objectId)?.desired ?? null;
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
      // Only a Provider can be renamed out of an identity collision; other kinds have no rename
      // path, so demanding a new Provider ID for them would make the conflict unresolvable.
      const renameable = candidate.row.kind === 'provider';
      return {
        ...candidate,
        ...(renameable ? { requiresProviderId: true } : {}),
        row: {
          ...candidate.row,
          change: 'conflict' as const,
          choices: ['local', 'cloud', 'restore'] as SyncPreviewRow['choices'],
          ...(renameable ? { requiresProviderId: true } : {}),
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
    candidates.some((candidate) =>
      remoteDependencies(remoteByObject.get(candidate.row.objectId)).some(
        (dependency) => !allRemoteIds.has(dependency.objectId) && !allLocalIds.has(dependency.objectId),
      ),
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

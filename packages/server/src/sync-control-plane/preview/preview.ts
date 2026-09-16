import {
  isTombstonedEntity,
  projectCommitted,
  providerDependencyPackage,
  type CommittedSource,
  type Dependency,
  type EntityBody,
  type LocalEntity,
  type OutboxOperation,
  type PluginRepository,
  type PluginRegistry,
} from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncPreview, SyncPreviewInput, SyncPreviewRow } from '@aio-proxy/types';
import { isEqual, isPlainObject } from 'es-toolkit/predicate';

import { authoredLocalEntities } from './connect-local';
import { snapshotLocalEntities, snapshotRemoteEntities, type RemoteEntity } from './entities';
import { SyncPreviewError } from './errors';
import type { PreviewFence } from './fence';
import { applyOverrides } from './overrides';
import { redactEntityValue, secretChange } from './redact';

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

// A tombstoned entity reports no live body, but its last payload still names the objects it linked
// to; dependency traversal has to see them so a rejoin or purge covers the whole graph.
function remoteDependencies(entity: RemoteEntity | undefined): readonly { readonly objectId: string }[] {
  return entity?.body?.dependencies ?? entity?.restoreBody?.dependencies ?? [];
}

// Selecting a side that carries no body is not a choice, it is a deletion: publishing a null body
// deletes a head the cloud may never have had, and importing one drops the local row. So a choice is
// only offered for a side that actually exists.
function sidedChoices(local: EntityBody | null, cloud: EntityBody | null): SyncPreviewRow['choices'] {
  return local === null ? ['cloud'] : cloud === null ? ['local'] : ['local', 'cloud'];
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
        : isEqual(local, cloud)
          ? 'update'
          : 'conflict';
  // Only a tombstone resolved a past revision for `restore` to publish. Every other row compares two
  // live heads, so `restore` there would just republish the cloud body.
  const choices: SyncPreviewRow['choices'] = change === 'delete' ? ['restore'] : sidedChoices(local, cloud);
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
  /** Publications this device has committed but not yet drained. Read by purge. */
  readonly queued?: readonly OutboxOperation[];
}): { readonly preview: SyncPreview; readonly record: PreviewRecord } {
  const remoteSnapshot = snapshotRemoteEntities(input.remote);
  // Connect is the one preview whose local side may not exist yet, and the rows it mints have to be
  // in the snapshot the record carries: applying reads its `current` row from there.
  const minted =
    input.request.kind === 'connect' && input.source !== undefined
      ? authoredLocalEntities(input.source, input.local, remoteSnapshot)
      : [];
  const localSnapshot = snapshotLocalEntities([...input.local, ...minted]);
  const mintedIds = new Set(minted.map((entity) => entity.objectId));
  // Connect reviews the committed configuration as its local side, for carried rows as much as for
  // minted ones: a local edit whose publication the old backend has not reconciled yet leaves
  // `desired` holding the last remote baseline, so reviewing that would show a stale body as "Local"
  // and applying it would publish the superseded configuration to the replacement backend. Only the
  // minted rows are forced included: doing that for every carried row would turn a backend switch
  // into a mass join of objects the user left excluded.
  const connectBodies =
    input.request.kind !== 'connect' || input.source === undefined
      ? undefined
      : projectCommitted(
          input.source,
          localSnapshot.map((entity) =>
            mintedIds.has(entity.objectId) ? { ...entity, mode: 'included' as const } : entity,
          ),
        ).entities;
  const localByObject = new Map(localSnapshot.map((entity) => [entity.objectId, entity]));
  const remoteByObject = new Map(remoteSnapshot.map((entity) => [entity.objectId, entity]));
  const ids = new Set<string>();
  // Set by purge alone: a dependent whose queued publication would outlive the erase.
  let queuedDependency = false;
  if (input.request.kind === 'join') {
    // `providerId` is the logical key of any kind, not only a Provider: a model rule is joined the
    // same way. But `sync join PROVIDER_ID` names a Provider, so when one answers to the key it is
    // the only thing joined — otherwise a rule or plugin that happens to spell its identity the same
    // way would be dragged into the Provider's join and published with it. Dependencies discovered
    // below still expand the selection across kinds.
    const providerId = input.request.providerId;
    const named = [...localSnapshot, ...remoteSnapshot].filter((entity) => entity.logicalKey === providerId);
    const scoped = named.some((entity) => entity.kind === 'provider')
      ? named.filter((entity) => entity.kind === 'provider')
      : named;
    // Re-creating a deleted Provider under the same ID keeps the tombstone beside the fresh row, and
    // both answer to the key. Joining both offers a revive and a publication of one Provider ID at
    // once, which `assertDecisions` rejects as a collision — so the re-created Provider could never
    // be joined at all. A tombstone with no live row beside it is still a join target: that is the
    // rejoin of a Provider a peer deleted while this device kept its configuration.
    const retired = (entity: LocalEntity | RemoteEntity): boolean =>
      'overrides' in entity ? isTombstonedEntity(entity) : entity.tombstone === true;
    const live = scoped.filter((entity) => !retired(entity));
    for (const entity of live.length > 0 ? live : scoped) ids.add(entity.objectId);
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
  } else if (input.request.kind === 'restore') ids.add(input.request.objectId);
  else if (input.request.kind === 'overrides') {
    ids.add(input.request.objectId);
    // Pinning a path republishes the Provider's body, and that body names the business plugin object
    // it needs. Projecting the plugin so a body exists, without previewing it, published a Provider
    // whose dependency nothing publishes: every other device then holds it pending on an object the
    // space does not have. The join path carries the same object for the same reason.
    const logicalKey = localByObject.get(input.request.objectId)?.logicalKey;
    const dependency =
      logicalKey === undefined || input.source === undefined
        ? undefined
        : providerDependencyPackage(input.source.raw, logicalKey);
    if (dependency !== undefined)
      for (const entity of localSnapshot)
        if (entity.kind === 'plugin-business' && entity.logicalKey === dependency) ids.add(entity.objectId);
  } else if (input.request.kind === 'purge') {
    const purge = input.request;
    const remoteIds = new Set(remoteSnapshot.map((entity) => entity.objectId));
    // A row's `desired` is the body the last drain published, so an edit made while the backend was
    // unreachable names its new dependencies only in the outbox. Walking published bodies alone
    // misses a rule that has just started referencing the purge target: erasing it anyway lets the
    // next drain publish that rule against an object no peer can resolve. Newest queued body wins,
    // and a queued delete carries none — the object is on its way out.
    const queued = new Map<string, readonly Dependency[]>(
      (input.queued ?? []).map((operation) => [operation.objectId, operation.body?.dependencies ?? []]),
    );
    const all = [
      ...localSnapshot.map((entity) => ({
        objectId: entity.objectId,
        logicalKey: entity.logicalKey,
        kind: entity.kind,
        remote: false,
        dependencies: queued.get(entity.objectId) ?? entity.desired?.dependencies ?? [],
      })),
      ...remoteSnapshot.map((entity) => ({
        objectId: entity.objectId,
        logicalKey: entity.logicalKey,
        kind: entity.kind,
        remote: true,
        dependencies: remoteDependencies(entity),
      })),
    ];
    const roots = new Set(
      all
        .filter((entity) =>
          purge.scope === 'provider'
            ? entity.kind === 'provider' && entity.logicalKey === purge.objectId
            : entity.kind === 'plugin-business' && entity.logicalKey === purge.objectId,
        )
        .map((entity) => entity.objectId),
    );
    const targets = new Set(roots);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entity of all) {
        if (entity.dependencies.some((dependency) => targets.has(dependency.objectId))) {
          if (!targets.has(entity.objectId)) {
            targets.add(entity.objectId);
            changed = true;
          }
        }
      }
    }
    for (const objectId of targets) {
      if (remoteIds.has(objectId)) ids.add(objectId);
      // A local-only dependent has no cloud head, so a purge erases nothing of it and it is no row
      // of this preview. Its queued publication lands after the erase all the same, so it blocks the
      // Apply instead of being shown as collateral.
      else if (!roots.has(objectId) && queued.has(objectId)) queuedDependency = true;
    }
  } else for (const id of [...localByObject.keys(), ...remoteByObject.keys()]) ids.add(id);
  const identityGroups = new Map<string, Set<string>>();
  // A tombstoned head no longer claims its identity, on either side. Counting one would report a
  // collision against the one live object that remains and, for a Provider, demand a replacement
  // Provider ID to resolve a duplicate that has already been deleted or purged — a resolution
  // `assertDecisions` then rejects, since it frees a tombstone's Provider ID by the same rule
  // reconciliation does. It is a restore preview that pays for this: rolling a deleted object back
  // is exactly when a local tombstone is in play, and the rename it demanded would publish onto a
  // head whose logical key is immutable, so it could only fail as `invalid-data`.
  for (const entity of [
    ...localSnapshot.filter((entity) => !isTombstonedEntity(entity)),
    ...remoteSnapshot.filter((entity) => entity.tombstone !== true),
  ]) {
    const groupKey = `${entity.kind}\0${entity.logicalKey}`;
    const idsForKey = identityGroups.get(groupKey) ?? new Set<string>();
    idsForKey.add(entity.objectId);
    identityGroups.set(groupKey, idsForKey);
  }
  const identityConflictKeys = new Set(
    [...identityGroups].filter(([, objectIds]) => objectIds.size > 1).map(([groupKey]) => groupKey),
  );
  // A local-only object has no published body, so its stored `desired` is null and the join would
  // preview and publish nothing. Project the authored configuration as if the selected set were
  // already included: that yields the exact bodies applying the local choice will publish,
  // dependencies included, and reuses the one projection the commit path uses rather than a second
  // encoding. An override pins a path of that same authored body, so it needs the projection too —
  // reading the published body there would pin `undefined` and delete the value locally. An
  // override previews the Provider's business plugin alongside it, so the projection keeps a body.
  const joined =
    (input.request.kind !== 'join' && input.request.kind !== 'overrides') || input.source === undefined
      ? undefined
      : projectCommitted(
          input.source,
          localSnapshot.map((entity) => (ids.has(entity.objectId) ? { ...entity, mode: 'included' as const } : entity)),
        ).entities;
  // Joining an object can rewrite the projected body of one already included — a model rule whose
  // Provider reference only resolves once that Provider joins. Those rows are not in `ids`, so
  // without this they keep their stale published body and the cloud is left internally inconsistent.
  if (input.request.kind === 'join' && joined !== undefined)
    for (const entity of localSnapshot)
      if (entity.mode === 'included' && !ids.has(entity.objectId)) {
        const next = joined.get(entity.objectId);
        if (next !== undefined && !isEqual(next, entity.desired)) ids.add(entity.objectId);
      }
  const candidateIds =
    input.request.kind === 'purge' ? [...ids].filter((objectId) => remoteByObject.has(objectId)) : [...ids];
  const candidates = candidateIds
    .map((objectId) =>
      (() => {
        const local =
          joined?.get(objectId) ?? connectBodies?.get(objectId) ?? localByObject.get(objectId)?.desired ?? null;
        const remoteEntity = remoteByObject.get(objectId);
        let remote: EntityBody | null;
        if (input.request.kind === 'restore') {
          // A requested operation ID is untrusted input: a plain lookup for `__proto__` would
          // resolve `Object.prototype` and pass as a restorable revision.
          const history = remoteEntity?.revisions;
          const operationId = input.request.operationId;
          const restored =
            history !== undefined && Object.hasOwn(history, operationId) ? history[operationId] : undefined;
          if (restored === undefined) throw new SyncPreviewError('not-connected');
          remote = restored;
        } else remote = remoteEntity?.body ?? null;
        // The pinned paths belong to the requested object. The plugin row rides along so its body is
        // published too, unpinned.
        if (input.request.kind === 'overrides' && objectId === input.request.objectId && local !== null)
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
      // Connect may omit a row that joins nothing, and the dialog has to know which rows those are
      // so it can leave them unselected. Deriving it client-side from `cloud` would miss a row
      // whose only cloud state is a restorable revision, so publish the server's own rule here and
      // let assertDecisions read it back instead of re-deriving it.
      if (input.request.kind !== 'connect') return candidate;
      // A tombstoned head is one of those rows: the swap's reconciliation imports nothing from a
      // deleted object, so the only decision left is whether to revive it. Requiring one would make
      // a first connect resurrect a cloud object the space already deleted — and on the sole choice
      // `restore` offers, with no way to keep the authored configuration local-only.
      if (remoteByObject.get(candidate.row.objectId)?.tombstone === true)
        return { ...candidate, row: { ...candidate.row, optional: true } };
      if (candidate.cloud !== null || (candidate.restoreBody ?? null) !== null) return candidate;
      return { ...candidate, row: { ...candidate.row, optional: true } };
    })
    .map((candidate) => {
      // A restore rolls one object's own head back to a past revision and never publishes a new
      // object, while `restoreEntity` rejects a body whose logical key differs from that head's
      // immutable one. Demanding a replacement Provider ID here — and `assertDecisions` makes it
      // mandatory once asked for — would make every restore of a colliding Provider fail as
      // `invalid-data`. Freeing the identity is the conflict flow's job and stays available there.
      if (input.request.kind === 'purge' || input.request.kind === 'restore') return candidate;
      if (!identityConflictKeys.has(`${candidate.row.kind}\0${candidate.row.logicalKey}`)) return candidate;
      // Only a Provider can be renamed out of an identity collision; other kinds have no rename
      // path, so demanding a new Provider ID for them would make the conflict unresolvable.
      const renameable = candidate.row.kind === 'provider';
      // Without a rename, picking a body resolves nothing: both heads still claim the identity and
      // reconciliation quarantines them again. Retiring one head is the only escape, so offer it on
      // every colliding row that has a live cloud head of its own.
      const deletable = !renameable && candidate.cloud !== null;
      return {
        ...candidate,
        ...(renameable ? { requiresProviderId: true } : {}),
        row: {
          ...candidate.row,
          change: 'conflict' as const,
          // A collision is reported as a conflict even when one of its objects lives on a single
          // side. That row still has only one real body, so the missing side stays off the list:
          // choosing it would publish or import a null and delete a head the rename needs.
          choices: [
            ...sidedChoices(candidate.local, candidate.cloud),
            ...(deletable ? (['delete'] as const) : []),
          ] as SyncPreviewRow['choices'],
          ...(renameable ? { requiresProviderId: true } : {}),
        },
      };
    })
    .map((candidate) =>
      // A restore preview resolves one past revision and reports it as the cloud side, so a
      // conflicting row there really can be rolled back. Every other preview compares two live
      // heads and resolved no past revision, so it has nothing for `restore` to publish. Restore is
      // added to the row's own choices rather than replacing them: a collision row forced to
      // `conflict` still exists on one side only.
      input.request.kind !== 'restore' || candidate.row.change !== 'conflict'
        ? candidate
        : {
            ...candidate,
            row: { ...candidate.row, choices: [...candidate.row.choices, 'restore'] as SyncPreviewRow['choices'] },
          },
    );
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
    (queuedDependency ||
      candidates.some((candidate) =>
        remoteDependencies(remoteByObject.get(candidate.row.objectId)).some(
          (dependency) => !allRemoteIds.has(dependency.objectId) && !allLocalIds.has(dependency.objectId),
        ),
      ));
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

export function objectValue(value: unknown): Record<string, JsonValue> {
  return isPlainObject(value) ? (value as Record<string, JsonValue>) : {};
}

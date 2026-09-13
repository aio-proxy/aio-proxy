import type { EntityBody, LocalEntity } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isEqual, isPlainObject } from 'es-toolkit/predicate';

import type { RemoteEntity } from '../preview';
import { SyncOperationError } from './errors';

export type ProviderIdentityRows = {
  readonly oldProviderId: string;
  readonly newProviderId: string;
  readonly entities: readonly LocalEntity[];
  /** The renamed row itself, which carries a fresh object identity once the old one was published. */
  readonly renamed: LocalEntity;
  /** Whether the old object still exists remotely and has to be removed after the rename lands. */
  readonly replacesPublished: boolean;
};

/**
 * Renames one Provider ID key of a schema-owned reference map, or returns undefined when there is
 * nothing to move. A Provider ID is user data, so it can be `__proto__`: plain assignment reaches
 * the legacy prototype setter and drops the entry, on the replacement and on every hop that
 * rebuilds the map.
 */
function renameProviderKey(
  value: JsonValue | undefined,
  oldProviderId: string,
  newProviderId: string,
): JsonValue | undefined {
  if (!isPlainObject(value)) return undefined;
  const source = value as Record<string, JsonValue>;
  if (!Object.hasOwn(source, oldProviderId)) return undefined;
  // Renaming onto an ID this map already lists would drop one of the two entries.
  if (Object.hasOwn(source, newProviderId)) throw new SyncOperationError('upgrade-required');
  return Object.fromEntries(
    Object.entries(source).map(([id, reference]) => [id === oldProviderId ? newProviderId : id, reference]),
  );
}

/**
 * A model rule's published body is its authored policy, whose `providers` map is keyed by Provider
 * ID. Nothing else in the body names a Provider.
 */
function rewireModelPolicy(value: JsonValue, oldProviderId: string, newProviderId: string): JsonValue {
  if (!isPlainObject(value)) return value;
  const policy = value as Record<string, JsonValue>;
  const providers = renameProviderKey(policy['providers'], oldProviderId, newProviderId);
  return providers === undefined ? value : { ...policy, providers };
}

/**
 * Moves every authored reference to `oldProviderId` onto `newProviderId`. The configuration schema
 * names a Provider in exactly two places — the `providers` map at the root and the `providers` map
 * of each `router.models` rule — so only those are rewritten. Plugin and provider options are
 * opaque: rewriting a `providerId` that merely looks like ours would silently change an upstream
 * identifier, and refusing a `providers` option that is not a map would fail the rename outright.
 */
export function rewireProviderReferences(
  authored: Record<string, JsonValue>,
  oldProviderId: string,
  newProviderId: string,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = { ...authored };
  const providers = renameProviderKey(authored['providers'], oldProviderId, newProviderId);
  if (providers !== undefined) result['providers'] = providers;
  const router = authored['router'];
  const models = isPlainObject(router) ? (router as Record<string, JsonValue>)['models'] : undefined;
  if (isPlainObject(models)) {
    result['router'] = {
      ...(router as Record<string, JsonValue>),
      // A model name is user data too, so the map is rebuilt entry-wise for the same reason.
      models: Object.fromEntries(
        Object.entries(models as Record<string, JsonValue>).map(([model, policy]) => [
          model,
          rewireModelPolicy(policy, oldProviderId, newProviderId),
        ]),
      ),
    };
  }
  return result;
}

export function providerIdentityRows(
  current: LocalEntity,
  selected: EntityBody,
  newProviderId: string,
  entities: readonly LocalEntity[],
  published: boolean,
): ProviderIdentityRows {
  if (current.kind !== 'provider' || selected.kind !== 'provider' || newProviderId === '')
    throw new SyncOperationError('upgrade-required');
  if (
    entities.some(
      (entity) =>
        entity.objectId !== current.objectId && entity.kind === 'provider' && entity.logicalKey === newProviderId,
    )
  )
    throw new SyncOperationError('upgrade-required');
  // A published head's logical key is immutable, so the rename cannot be pushed through the same
  // object. The renamed configuration becomes a new object and the old one is deleted afterwards,
  // which is also what clears the colliding identity out of the cloud.
  const renamed: LocalEntity = {
    ...current,
    logicalKey: newProviderId,
    desired: { ...selected, logicalKey: newProviderId },
    ...(published ? { objectId: crypto.randomUUID(), epoch: 0, baseline: null } : {}),
  };
  const mapped = entities.map((entity) => {
    if (entity.objectId === current.objectId) return renamed;
    if (entity.desired?.kind !== 'model-rule') return entity;
    return {
      ...entity,
      desired: {
        ...entity.desired,
        value: rewireModelPolicy(entity.desired.value, current.logicalKey, newProviderId),
      },
    };
  });
  return {
    oldProviderId: current.logicalKey,
    newProviderId,
    renamed,
    replacesPublished: published,
    // Persist only rows whose provider identity or structured references changed. This lets a
    // repository that predates bulk persistence handle a provider-only rename atomically while
    // still refusing a multi-row mapping that it cannot write as one transaction.
    entities: mapped.filter((entity, index) => !isEqual(entity, entities[index])),
  };
}

/**
 * The entity a rename needs when the colliding object lives only in the cloud. Its identity group
 * is entirely remote, so there is nothing local to rename — but the rename still has to reach the
 * backend, or the immutable head keeps the old Provider ID and the next reconciliation quarantines
 * the same collision again.
 */
export function remoteIdentityEntity(objectId: string, remote: RemoteEntity | undefined): LocalEntity | undefined {
  if (remote?.body == null || remote.kind !== 'provider') return undefined;
  return {
    objectId,
    logicalKey: remote.logicalKey,
    kind: 'provider',
    mode: 'included',
    // Deleting the head it vacates is an epoch-exact operation, so the remote epoch is the one
    // field that cannot be defaulted away.
    epoch: remote.epoch ?? 0,
    desired: remote.body,
    baseline: remote.revision,
    overrides: [],
    pendingReason: null,
  };
}

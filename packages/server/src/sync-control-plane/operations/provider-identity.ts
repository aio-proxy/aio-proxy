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
 * Moves every reference to `oldProviderId` onto `newProviderId`: the keys of `providers`/`accounts`
 * maps and the `providerId`/`accountProviderId` scalars that name them. Shared by the entity bodies
 * a rename publishes and the authored configuration those bodies are projected from, so the two can
 * never disagree about which Provider ID a rule points at.
 */
export function rewireProviderReferences(value: JsonValue, oldProviderId: string, newProviderId: string): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => rewireProviderReferences(entry, oldProviderId, newProviderId));
  if (!isPlainObject(value)) return value;
  // A Provider ID is user data, so it can be `__proto__`: plain assignment reaches the legacy
  // prototype setter and drops the entry, on the replacement and on every hop that rebuilds the map.
  return Object.fromEntries(
    Object.entries(value).map(([key, child]): [string, JsonValue] => {
      if (key === 'providers' || key === 'accounts') {
        if (!isPlainObject(child)) throw new SyncOperationError('upgrade-required');
        const source = child as Record<string, JsonValue>;
        if (Object.hasOwn(source, oldProviderId) && Object.hasOwn(source, newProviderId))
          throw new SyncOperationError('upgrade-required');
        const moved = Object.entries(source).map(([id, ref]) => [id === oldProviderId ? newProviderId : id, ref]);
        return [key, rewireProviderReferences(Object.fromEntries(moved), oldProviderId, newProviderId)];
      }
      if ((key === 'providerId' || key === 'accountProviderId') && child === oldProviderId) return [key, newProviderId];
      return [key, rewireProviderReferences(child, oldProviderId, newProviderId)];
    }),
  );
}

function validateStructuredReferenceMaps(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const entry of value) validateStructuredReferenceMaps(entry);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'providers' || key === 'accounts') && !isPlainObject(child))
      throw new SyncOperationError('upgrade-required');
    validateStructuredReferenceMaps(child);
  }
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
  validateStructuredReferenceMaps(selected.value);
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
        value: rewireProviderReferences(entity.desired.value, current.logicalKey, newProviderId),
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

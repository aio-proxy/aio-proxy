import type { EntityBody, LocalEntity, LocalBinding, SyncRepository } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncStatus } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import type { PreviewFence, PreviewRecord, RemoteEntity } from './preview';
import { SyncPreviewError, sameFence } from './preview';

export class SyncOperationError extends Error {
  override readonly name = 'SyncOperationError';
  constructor(
    readonly code:
      | 'not-connected'
      | 'dependency-in-use'
      | 'operation-pending'
      | 'upgrade-required'
      | 'backend-unavailable',
  ) {
    super(code);
  }
}

export type OperationInput = {
  readonly repo: SyncRepository;
  readonly binding: () => LocalBinding | null;
  readonly localEntities: () => readonly LocalEntity[];
  readonly remoteEntities: () => Promise<readonly RemoteEntity[]>;
  readonly fence: () => Promise<PreviewFence>;
  readonly status: () => SyncStatus;
  readonly applyLocal: (candidate: EntityBody | null, current: LocalEntity | undefined) => Promise<void>;
  readonly applyCloud: (
    candidate: EntityBody | null,
    current: LocalEntity | undefined,
    expectedVersion: string | null,
  ) => Promise<void>;
  readonly restore: (
    objectId: string,
    candidate: EntityBody,
    operationId: string,
    current: LocalEntity | undefined,
    expectedVersion: string | null,
  ) => Promise<void>;
  readonly purge: (objectId: string, expectedVersion: string | null) => Promise<void>;
  readonly persistOverrides: (
    objectId: string,
    paths: readonly string[][],
    current: LocalEntity | undefined,
  ) => Promise<void>;
  readonly persistProviderIdentity?: (
    oldProviderId: string,
    newProviderId: string,
    entities: readonly LocalEntity[],
  ) => Promise<void>;
  readonly now?: () => number;
};

type ProviderIdentityRows = {
  readonly oldProviderId: string;
  readonly newProviderId: string;
  readonly entities: readonly LocalEntity[];
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rewireProviderReferences(value: JsonValue, oldProviderId: string, newProviderId: string): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => rewireProviderReferences(entry, oldProviderId, newProviderId));
  if (!isPlainObject(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'providers' || key === 'accounts') {
      if (!isPlainObject(child)) throw new SyncOperationError('upgrade-required');
      const references = { ...(child as Record<string, JsonValue>) };
      if (Object.hasOwn(references, oldProviderId)) {
        if (Object.hasOwn(references, newProviderId)) throw new SyncOperationError('upgrade-required');
        references[newProviderId] = references[oldProviderId]!;
        delete references[oldProviderId];
      }
      result[key] = rewireProviderReferences(references, oldProviderId, newProviderId);
    } else if ((key === 'providerId' || key === 'accountProviderId') && child === oldProviderId) {
      result[key] = newProviderId;
    } else result[key] = rewireProviderReferences(child, oldProviderId, newProviderId);
  }
  return result;
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

function providerIdentityRows(
  current: LocalEntity,
  selected: EntityBody,
  newProviderId: string,
  entities: readonly LocalEntity[],
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
  const mapped = entities.map((entity) => {
    if (entity.objectId === current.objectId)
      return { ...entity, logicalKey: newProviderId, desired: { ...selected, logicalKey: newProviderId } };
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
    // Persist only rows whose provider identity or structured references changed. This lets a
    // repository that predates bulk persistence handle a provider-only rename atomically while
    // still refusing a multi-row mapping that it cannot write as one transaction.
    entities: mapped.filter((entity, index) => !sameJson(entity, entities[index])),
  };
}

async function persistProviderIdentity(input: OperationInput, rows: ProviderIdentityRows): Promise<void> {
  if (input.persistProviderIdentity !== undefined) {
    await input.persistProviderIdentity(rows.oldProviderId, rows.newProviderId, rows.entities);
    return;
  }
  const binding = input.binding();
  if (binding === null) throw new SyncPreviewError('not-connected');
  const repository = input.repo as SyncRepository & {
    readonly putEntities?: (bindingId: string, entities: readonly LocalEntity[]) => void;
  };
  if (typeof repository.putEntities === 'function') {
    repository.putEntities(binding.id, rows.entities);
    return;
  }
  if (rows.entities.length !== 1 || typeof input.repo.putEntity !== 'function')
    throw new SyncOperationError('upgrade-required');
  input.repo.putEntity(binding.id, rows.entities[0]!);
}

export async function assertFresh(input: OperationInput, expected: PreviewFence): Promise<void> {
  const current = await input.fence();
  if (!sameFence(expected, current)) throw new SyncPreviewError('preview-stale');
}

export async function applyPreview(
  input: OperationInput,
  record: PreviewRecord,
  decisions: readonly { objectId: string; choice: 'local' | 'cloud' | 'restore'; newProviderId?: string }[],
): Promise<SyncStatus> {
  const binding = input.binding();
  if (binding === null) throw new SyncPreviewError('not-connected');
  if (input.now?.() !== undefined && input.now!() >= record.expiresAt) throw new SyncPreviewError('preview-stale');
  await assertFresh(input, record.fence);
  const selected = new Map(decisions.map((decision) => [decision.objectId, decision]));
  const localByObject = new Map(record.local.map((entity) => [entity.objectId, entity]));
  const remoteByObject = new Map(record.remote.map((entity) => [entity.objectId, entity]));
  if (record.input.kind === 'purge') {
    if (record.dependencyError) throw new SyncOperationError('dependency-in-use');
    for (const candidate of record.rows) {
      const remote = remoteByObject.get(candidate.row.objectId);
      if (remote === undefined) continue;
      await input.purge(candidate.row.objectId, remote?.version ?? null);
      const verified = (await input.remoteEntities()).find((entity) => entity.objectId === candidate.row.objectId);
      if (verified !== undefined && verified.tombstone !== true) throw new SyncOperationError('operation-pending');
    }
    return input.status();
  }
  if (record.input.kind === 'overrides') {
    const current = localByObject.get(record.input.objectId);
    await input.persistOverrides(record.input.objectId, record.input.paths, current);
  }
  for (const candidate of record.rows) {
    const decision = selected.get(candidate.row.objectId);
    if (decision === undefined) continue;
    if (candidate.requiresProviderId && decision.newProviderId === undefined)
      throw new SyncOperationError('upgrade-required');
    if (decision.newProviderId !== undefined && candidate.row.kind !== 'provider')
      throw new SyncOperationError('upgrade-required');
    if (!candidate.row.choices.includes(decision.choice)) throw new SyncOperationError('upgrade-required');
    const current = localByObject.get(candidate.row.objectId);
    let identityRows: ProviderIdentityRows | undefined;
    let selectedBody =
      decision.choice === 'local'
        ? candidate.local
        : decision.choice === 'cloud'
          ? candidate.cloud
          : record.input.kind === 'restore'
            ? candidate.cloud
            : (candidate.restoreBody ?? remoteByObject.get(candidate.row.objectId)?.body ?? null);
    if (decision.newProviderId !== undefined && selectedBody !== null) {
      selectedBody = { ...selectedBody, logicalKey: decision.newProviderId };
      if (current !== undefined)
        identityRows = providerIdentityRows(current, selectedBody, decision.newProviderId, record.local);
    }
    const remote = remoteByObject.get(candidate.row.objectId);
    if (identityRows !== undefined) await persistProviderIdentity(input, identityRows);
    try {
      if (decision.choice === 'restore' && selectedBody !== null) {
        const operationId =
          record.input.kind === 'restore' ? record.input.operationId : `restore:${candidate.row.objectId}`;
        await input.restore(candidate.row.objectId, selectedBody, operationId, current, remote?.version ?? null);
      } else if (decision.choice === 'cloud') {
        await input.applyLocal(selectedBody, current);
      } else {
        await input.applyCloud(selectedBody, current, remote?.version ?? null);
      }
    } catch (error) {
      if (identityRows !== undefined) {
        await persistProviderIdentity(input, {
          ...identityRows,
          entities: identityRows.entities.map((entity) => ({ ...entity, pendingReason: 'result-uncertain' })),
        });
      }
      throw error;
    }
    if (identityRows === undefined && current !== undefined && typeof input.repo.putEntity === 'function') {
      input.repo.putEntity(binding.id, {
        ...current,
        mode: 'included',
        desired: selectedBody,
        baseline: remote?.version ?? current.baseline,
        pendingReason: null,
      });
    }
  }
  return input.status();
}

export function setRange(input: OperationInput, providerId: string): SyncStatus {
  const binding = input.binding();
  if (binding === null) throw new SyncPreviewError('not-connected');
  const entity = input
    .localEntities()
    .find((candidate) => candidate.logicalKey === providerId && candidate.kind === 'provider');
  if (entity === undefined) throw new SyncOperationError('upgrade-required');
  input.repo.putEntity(binding.id, { ...entity, mode: 'excluded', pendingReason: null });
  return input.status();
}

import type { EntityBody, LocalEntity, LocalBinding, SyncRepository } from '@aio-proxy/core';
import type { SyncStatus } from '@aio-proxy/types';

import type { PreviewFence, PreviewRecord, RemoteEntity } from './preview';
import { SyncPreviewError, sameFence } from './preview';

export class SyncOperationError extends Error {
  override readonly name = 'SyncOperationError';
  constructor(readonly code: 'not-connected' | 'dependency-in-use' | 'operation-pending' | 'upgrade-required') {
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
  readonly applyLocal?: (candidate: EntityBody | null, current: LocalEntity | undefined) => Promise<void>;
  readonly applyCloud?: (candidate: EntityBody | null, current: LocalEntity | undefined) => Promise<void>;
  readonly now?: () => number;
};

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
  const localByObject = new Map(input.localEntities().map((entity) => [entity.objectId, entity]));
  const remoteByObject = new Map((await input.remoteEntities()).map((entity) => [entity.objectId, entity]));
  for (const candidate of record.rows) {
    const decision = selected.get(candidate.row.objectId);
    if (decision === undefined) continue;
    if (candidate.requiresProviderId && decision.newProviderId === undefined)
      throw new SyncOperationError('upgrade-required');
    if (!candidate.row.choices.includes(decision.choice)) throw new SyncOperationError('upgrade-required');
    const current = localByObject.get(candidate.row.objectId);
    let selectedBody =
      decision.choice === 'local'
        ? candidate.local
        : decision.choice === 'cloud'
          ? candidate.cloud
          : (remoteByObject.get(candidate.row.objectId)?.body ?? null);
    if (decision.newProviderId !== undefined && selectedBody !== null) {
      selectedBody = { ...selectedBody, logicalKey: decision.newProviderId };
    }
    if (decision.choice === 'cloud' || decision.choice === 'restore') await input.applyCloud?.(selectedBody, current);
    else await input.applyLocal?.(selectedBody, current);
    if (current !== undefined && decision.choice === 'local' && typeof input.repo.putEntity === 'function') {
      input.repo.putEntity(binding.id, {
        ...current,
        desired: selectedBody,
        baseline: remoteByObject.get(current.objectId)?.version ?? current.baseline,
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

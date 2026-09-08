import { createHash } from 'node:crypto';

import type { CommittedSource } from '../projection';
import { projectCommitted } from '../projection';
import type { LocalEntity } from '../repository';
import type { CommitIntent, OutboxOperation, SyncRepository } from '../repository';

export interface LocalCommitPort {
  withFence<T>(run: () => Promise<T>): Promise<T>;
  /** Optional binding fence checked after each awaited local read and before repository writes. */
  assertCurrent?(): void;
  rawDigest(): Promise<string>;
  accountOperationsSettled(ids: readonly string[]): boolean;
  committedSource(): Promise<CommittedSource>;
}

function sameSourceRevisions(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function operationId(commitId: string, objectId: string): string {
  return createHash('sha256').update(`${commitId}\0${objectId}`).digest('hex');
}

function hasRecord(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key);
}

function authoredEntity(source: CommittedSource, entity: LocalEntity): boolean {
  switch (entity.kind) {
    case 'provider':
      return hasRecord(source.raw['providers'], entity.logicalKey);
    case 'model-rule': {
      const router = source.raw['router'];
      return hasRecord(
        hasRecord(router, 'models') ? (router as Record<string, unknown>)['models'] : undefined,
        entity.logicalKey,
      );
    }
    case 'plugin-business': {
      const plugins = source.raw['plugins'];
      return (
        Array.isArray(plugins) &&
        plugins.some((entry) => entry === entity.logicalKey || (Array.isArray(entry) && entry[0] === entity.logicalKey))
      );
    }
    case 'service-access':
      return hasRecord(source.raw, 'server');
    case 'routing-defaults':
      return hasRecord(source.raw, 'server') || hasRecord(source.raw, 'router');
  }
}

function committedOperations(
  commitId: string,
  source: CommittedSource,
  repo: SyncRepository,
  bindingId: string,
): OutboxOperation[] {
  const entities = repo.entities(bindingId);
  const projection = projectCommitted(source, entities);
  const puts = [...projection.entities].map(([objectId, body]) => ({
    operationId: operationId(commitId, objectId),
    objectId,
    epoch: entities.find((entity) => entity.objectId === objectId)?.epoch ?? 0,
    kind: 'put' as const,
    body,
    commitId,
  }));
  const deletes = entities
    .filter((entity) => entity.mode === 'included' && entity.baseline !== null && !authoredEntity(source, entity))
    .filter((entity) => !projection.entities.has(entity.objectId))
    .map((entity) => ({
      operationId: operationId(commitId, entity.objectId),
      objectId: entity.objectId,
      epoch: entity.epoch,
      kind: 'delete' as const,
      body: null,
      commitId,
    }));
  return [...puts, ...deletes];
}

async function confirmLocalCommitUnderFence(
  repo: SyncRepository,
  bindingId: string,
  commitId: string,
  port: LocalCommitPort,
): Promise<void> {
  const intent = repo.readCommit(bindingId, commitId);
  if (intent === null || intent.phase === 'confirmed') return;
  if (!port.accountOperationsSettled(intent.accountOperationIds)) return;
  if ((await port.rawDigest()) !== intent.afterDigest) return;
  port.assertCurrent?.();
  if (
    intent.beforeDigest === intent.afterDigest &&
    intent.accountOperationIds.length === 0 &&
    intent.sourceRevisions === undefined
  ) {
    repo.discard(bindingId, commitId);
    return;
  }

  const source = await port.committedSource();
  port.assertCurrent?.();
  if (intent.sourceRevisions !== undefined && !sameSourceRevisions(intent.sourceRevisions, source.sourceRevisions)) {
    return;
  }

  const latest = repo.latestConfirmedCommit(bindingId);
  const sourceRevisions = source.sourceRevisions ?? intent.sourceRevisions;
  const canDeduplicate =
    intent.accountOperationIds.length === 0 ||
    (intent.sourceRevisions !== undefined &&
      Object.keys(intent.sourceRevisions).length > 0 &&
      source.sourceRevisions !== undefined);
  if (
    intent.origin === 'local' &&
    canDeduplicate &&
    latest !== null &&
    latest.afterDigest === intent.afterDigest &&
    sameSourceRevisions(latest.sourceRevisions, sourceRevisions)
  ) {
    port.assertCurrent?.();
    repo.discard(bindingId, commitId);
    return;
  }

  repo.confirm(
    bindingId,
    commitId,
    intent.origin === 'remote' ? [] : committedOperations(commitId, source, repo, bindingId),
    sourceRevisions,
  );
}

export async function recoverLocalCommits(
  repo: SyncRepository,
  bindingId: string,
  port: LocalCommitPort,
): Promise<void> {
  await port.withFence(async () => {
    for (const intent of repo.pendingCommits(bindingId)) {
      if (!port.accountOperationsSettled(intent.accountOperationIds)) continue;
      const digest = await port.rawDigest();
      port.assertCurrent?.();
      if (digest === intent.beforeDigest && intent.beforeDigest !== intent.afterDigest) {
        repo.discard(bindingId, intent.commitId);
      } else if (digest === intent.afterDigest) {
        await confirmLocalCommitUnderFence(repo, bindingId, intent.commitId, port);
      }
    }
  });
}

export async function confirmLocalCommit(
  repo: SyncRepository,
  bindingId: string,
  commitId: string,
  port: LocalCommitPort,
): Promise<void> {
  await port.withFence(() => confirmLocalCommitUnderFence(repo, bindingId, commitId, port));
}

export function prepareLocalCommit(repo: SyncRepository, bindingId: string, input: Omit<CommitIntent, 'phase'>): void {
  repo.prepare(bindingId, { ...input, phase: 'prepared' });
}

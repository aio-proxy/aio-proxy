import { createHash } from 'node:crypto';

import { isEqual } from 'es-toolkit/predicate';

import type { CommittedSource } from '../projection';
import { authoredPluginPackages, projectCommitted, seedAuthoredEntities } from '../projection';
import type { LocalEntity } from '../repository';
import type { CommitIntent, OutboxOperation, SyncRepository } from '../repository';

export interface LocalCommitPort {
  withFence<T>(run: () => Promise<T>): Promise<T>;
  /** Optional binding fence checked after each awaited local read and before repository writes. */
  assertCurrent?(): void;
  rawDigest(): Promise<string>;
  accountOperationsSettled(ids: readonly string[]): boolean;
  /** False for a queued operation no drain can ever publish, so drift may replace it. */
  publishableQueued?(operation: OutboxOperation): boolean;
  committedSource(): Promise<CommittedSource>;
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
      // An OAuth Provider's plugin is authored by the Provider entry alone, so reading only the
      // `plugins` array here would take the seeded row for a removal and publish its deletion.
      return authoredPluginPackages(source.raw).has(entity.logicalKey);
    }
    case 'service-access':
      return hasRecord(source.raw, 'server');
    case 'routing-defaults':
      return hasRecord(source.raw, 'server') || hasRecord(source.raw, 'router');
  }
}

function pluginSecretsMatch(source: CommittedSource, intent: CommitIntent): boolean {
  return (intent.pluginSecrets ?? []).every((change) => {
    const present = source.pluginSecrets.has(change.plugin);
    const expectedPresent = change.after !== undefined;
    return present === expectedPresent && (!present || isEqual(source.pluginSecrets.get(change.plugin), change.after));
  });
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
  // A plugin secret lives outside the configuration file, so changing only a secret leaves both
  // digests identical. Treating that as a watcher no-op would leave every other device on the old
  // credential until an unrelated edit happened to publish the plugin object again.
  if (
    intent.beforeDigest === intent.afterDigest &&
    intent.accountOperationIds.length === 0 &&
    (intent.remoteOperations === undefined || intent.remoteOperations.length === 0) &&
    (intent.pluginSecrets === undefined || intent.pluginSecrets.length === 0) &&
    intent.sourceRevisions === undefined
  ) {
    repo.discard(bindingId, commitId);
    return;
  }

  const source = await port.committedSource();
  port.assertCurrent?.();
  // An authored object with no local row can be neither selected nor excluded, so it would be
  // invisible to status and to a join. Every locally authored commit tops the rows up from what the
  // configuration now declares; the new rows are excluded, so this publishes nothing by itself.
  // Remote-origin commits are skipped: discovery owns those rows and already carries the cloud
  // object ID, so minting a second row here would read back as an identity collision.
  if (intent.origin === 'local') seedAuthoredEntities(repo, bindingId, source.raw);
  if (!pluginSecretsMatch(source, intent)) return;
  if (intent.sourceRevisions !== undefined && !isEqual(intent.sourceRevisions, source.sourceRevisions)) {
    return;
  }

  const latest = repo.latestConfirmedCommit(bindingId);
  const sourceRevisions = source.sourceRevisions ?? intent.sourceRevisions;
  const canDeduplicate =
    // The digest cannot witness a secret change, so a commit carrying one is never a duplicate of
    // the last confirmed commit even when both wrote the same configuration.
    (intent.pluginSecrets === undefined || intent.pluginSecrets.length === 0) &&
    (intent.accountOperationIds.length === 0 ||
      (intent.sourceRevisions !== undefined &&
        Object.keys(intent.sourceRevisions).length > 0 &&
        source.sourceRevisions !== undefined));
  if (
    intent.origin === 'local' &&
    canDeduplicate &&
    latest !== null &&
    latest.afterDigest === intent.afterDigest &&
    isEqual(latest.sourceRevisions, sourceRevisions)
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

/**
 * Records the file as it stands as the published baseline, publishing nothing. Connect and join send
 * the reviewed rows straight to the backend, and only an import writes the configuration file, so a
 * first connect to an empty space — or one where every reviewed row was kept local — confirms no
 * commit at all. Drift below is a digest comparison against the last confirmed commit, so with none
 * to compare against every later external edit would be loaded locally and never published, for the
 * lifetime of the binding. That apply is what made the cloud agree with the file, so the file is the
 * baseline.
 *
 * ponytail: an edit landing between that apply and this pass is adopted rather than published, so the
 * cloud stays on the applied bodies until the configuration changes again — every later drift commit
 * publishes the whole projection, so the next change carries this one's content too. Seeding a delta
 * instead is not safe here: a row records what this device published, so an object the cloud owns and
 * this device never published looks exactly like an unpublished local edit, and publishing it echoes
 * a freshly imported object back — dropping the shared plugin secret the file cannot carry. Closing
 * the window properly means the connect apply confirming a baseline commit for the file it writes.
 */
function seedBaseline(repo: SyncRepository, bindingId: string, digest: string, source: CommittedSource): void {
  const commitId = crypto.randomUUID();
  prepareLocalCommit(repo, bindingId, {
    commitId,
    origin: 'local',
    beforeDigest: digest,
    afterDigest: digest,
    rawAfter: source.raw,
    accountOperationIds: [],
  });
  repo.confirm(bindingId, commitId, [], source.sourceRevisions);
}

// Local publication is intent-driven, so a configuration that reached the file without one leaves
// every other device on the superseded objects until a later mutation happens to republish them.
// Two paths produce that: an external edit the watcher reloads without rewriting the file, and a
// mutation that died between its candidate's rename and the intent journaled after it. The file is
// authoritative, and nothing was written for this intent, so one the pass cannot confirm — the file
// moved again while it was read — is dropped rather than left prepared, matching a state that can
// never come back; the next pass re-reads the drift. A digest cannot witness a plugin secret, so a
// secret-only change is still the writer's own intent to journal.
async function publishLocalDrift(repo: SyncRepository, bindingId: string, port: LocalCommitPort): Promise<void> {
  // Queued operations are the newest state a drain is still carrying, and this pass drains after it.
  // Recomputing puts from the file alongside them would order a put behind a delete the same drain
  // is about to publish, and the outbox's newest-wins rule would drop that delete. Whatever drift
  // survives the drain is still there for the next pass. An entry the drain reports unpublishable is
  // not work in flight: a body over the backend's value limit is retried forever by design, because
  // shrinking the configuration is what replaces it — and that edit is drift, so waiting for the
  // queue to empty first would wedge the one path out of quota.
  if (repo.pendingCommits(bindingId).length > 0) return;
  if (repo.outbox(bindingId).some((operation) => port.publishableQueued?.(operation) ?? true)) return;
  const latest = repo.latestConfirmedCommit(bindingId);
  const afterDigest = await port.rawDigest();
  port.assertCurrent?.();
  if (latest !== null && afterDigest === latest.afterDigest) return;
  const source = await port.committedSource();
  port.assertCurrent?.();
  if (latest === null) {
    seedBaseline(repo, bindingId, afterDigest, source);
    return;
  }
  const commitId = crypto.randomUUID();
  prepareLocalCommit(repo, bindingId, {
    commitId,
    origin: 'local',
    beforeDigest: latest.afterDigest,
    afterDigest,
    rawAfter: source.raw,
    accountOperationIds: [],
  });
  await confirmLocalCommitUnderFence(repo, bindingId, commitId, port);
  if (repo.readCommit(bindingId, commitId)?.phase !== 'confirmed') repo.discard(bindingId, commitId);
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
      } else if (repo.latestConfirmedCommit(bindingId)?.afterDigest === digest) {
        // Neither digest matches, but a confirmed commit owns the file as it stands: this intent was
        // overtaken while its account operations were still draining. Leaving it prepared strands it
        // forever, since no future file state can match it again. Discarding publishes nothing —
        // `committedOperations` recomputes puts and deletes from the current source, so the commit
        // that superseded this one already carried whatever it would have sent.
        repo.discard(bindingId, intent.commitId);
      }
    }
    await publishLocalDrift(repo, bindingId, port);
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

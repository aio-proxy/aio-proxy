import { createHash } from 'node:crypto';

import {
  AtomicConfigCommitUncertainError,
  type CommittedSource,
  confirmLocalCommit,
  type EntityBody,
  type LocalSyncPort,
  type PendingReason,
  type PluginRegistry,
  type PluginRepository,
  type PluginSecretCommit,
  type SyncRepository,
  encodeCandidate,
  overlayLocal,
  projectCommitted,
  prepareLocalCommit,
} from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isEqual } from 'es-toolkit/predicate';

import type { ConfigStore } from '../../config-store';
import type { FifoQueue } from '../../fifo-queue';
import { applyBody, record, removeBody } from './entity-body';

type ConfigFile = NonNullable<ConfigStore['file']>;

export type PluginSecretChange = {
  readonly plugin: string;
  readonly value: JsonValue | undefined;
};

export type LocalPortInput = {
  readonly configPath: string;
  readonly configFile: ConfigFile;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly bindingId: string;
  readonly bindingGeneration?: number;
  readonly enqueue: FifoQueue;
  readonly registry: () => PluginRegistry;
  readonly applyCandidate: (
    raw: Record<string, JsonValue>,
    origin: 'local' | 'remote',
    operationId?: string,
    pluginSecret?: PluginSecretChange,
    expectedDigest?: string,
  ) => Promise<void>;
  readonly checkActivation?: (
    raw: Record<string, JsonValue>,
    body: EntityBody,
    signal: AbortSignal,
  ) => Promise<PendingReason | undefined>;
  readonly entities?: () => ReturnType<SyncRepository['entities']>;
  readonly pluginVersions?: () => ReadonlyMap<string, string>;
};

function digest(raw: Record<string, JsonValue>, path: string): string {
  return createHash('sha256').update(encodeCandidate(raw, path)).digest('hex');
}

function secretMatches(snapshot: ReturnType<PluginRepository['readPluginSecret']>, expected: JsonValue | undefined) {
  return expected === undefined
    ? snapshot === null
    : snapshot !== null && isEqual(snapshot.value as JsonValue, expected);
}

function restorePluginSecret(
  accounts: PluginRepository,
  plugin: string,
  previous: ReturnType<PluginRepository['readPluginSecret']>,
): boolean {
  const current = accounts.readPluginSecret(plugin);
  if (previous === null) {
    if (current === null) return true;
    return accounts.deletePluginSecret(plugin, current.revision);
  }
  if (current === null) {
    try {
      accounts.writePluginSecret(plugin, null, previous.value);
      return true;
    } catch {
      return false;
    }
  }
  if (isEqual(current.value, previous.value)) return true;
  try {
    accounts.writePluginSecret(plugin, current.revision, previous.value);
    return true;
  } catch {
    return false;
  }
}

function pluginSecretChange(
  body: EntityBody | null,
  currentEntity: ReturnType<SyncRepository['entities']>[number] | undefined,
): PluginSecretChange | undefined {
  if (body?.kind === 'plugin-business') {
    const value = record(body.value);
    return { plugin: body.logicalKey, value: Object.hasOwn(value, 'secret') ? value['secret'] : undefined };
  }
  if (body === null && currentEntity?.mode === 'included' && currentEntity.kind === 'plugin-business')
    return { plugin: currentEntity.logicalKey, value: undefined };
  return undefined;
}

function source(input: LocalPortInput, raw: Record<string, JsonValue>): CommittedSource {
  const accounts = new Map(
    Object.keys(record(raw['providers']))
      .map((providerId) => [providerId, input.accounts.readAccount(providerId)] as const)
      .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null),
  );
  const plugins = Array.isArray(raw['plugins'])
    ? raw['plugins'].flatMap((value) => {
        const name = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
        return typeof name === 'string' ? [name] : [];
      })
    : [];
  const pluginSecrets = new Map(
    plugins
      .map((plugin) => [plugin, input.accounts.readPluginSecret(plugin)?.value] as const)
      .filter((entry) => entry[1] !== undefined),
  );
  const versions = input.pluginVersions?.() ?? new Map<string, string>();
  return { raw, accounts, pluginSecrets, pluginVersions: versions };
}

type RemoteApplyState = {
  readonly candidate: Record<string, JsonValue>;
  readonly secretChange: PluginSecretChange | undefined;
  readonly previousSecret: ReturnType<PluginRepository['readPluginSecret']>;
  readonly configNeedsApply: boolean;
  readonly shouldMutateSecret: boolean;
};

function resolvePreparedRemoteState(
  input: LocalPortInput,
  currentDigest: string,
  existingCommit: NonNullable<ReturnType<SyncRepository['readCommit']>>,
): RemoteApplyState | { readonly applied: false; readonly pending: 'secret-conflict' | 'invalid-config' } {
  const storedSecret = existingCommit.pluginSecrets?.[0];
  let secretChange: PluginSecretChange | undefined;
  let previousSecret: ReturnType<PluginRepository['readPluginSecret']> = null;
  let shouldMutateSecret = false;
  if (storedSecret !== undefined) {
    secretChange = { plugin: storedSecret.plugin, value: storedSecret.after };
    previousSecret = input.accounts.readPluginSecret(storedSecret.plugin);
    const beforeMatches = secretMatches(previousSecret, storedSecret.before);
    const afterMatches = secretMatches(previousSecret, storedSecret.after);
    if (!beforeMatches && !afterMatches) return { applied: false, pending: 'secret-conflict' };
    shouldMutateSecret = beforeMatches && !afterMatches;
  }
  if (currentDigest !== existingCommit.beforeDigest && currentDigest !== existingCommit.afterDigest)
    return { applied: false, pending: 'invalid-config' };
  return {
    candidate: record(existingCommit.rawAfter),
    secretChange,
    previousSecret,
    configNeedsApply:
      currentDigest === existingCommit.beforeDigest && existingCommit.beforeDigest !== existingCommit.afterDigest,
    shouldMutateSecret,
  };
}

function prepareNewRemoteState(
  input: LocalPortInput,
  current: Record<string, JsonValue>,
  currentEntities: ReturnType<SyncRepository['entities']>,
  currentEntity: ReturnType<SyncRepository['entities']>[number] | undefined,
  body: EntityBody | null,
  objectId: string,
  operationId: string,
  beforeDigest: string,
): RemoteApplyState {
  const secretChange = pluginSecretChange(body, currentEntity);
  const previousSecret = secretChange === undefined ? null : input.accounts.readPluginSecret(secretChange.plugin);
  const shared =
    body === null && currentEntity?.mode === 'included'
      ? removeBody(current, currentEntity, currentEntities)
      : applyBody(current, body, currentEntities);
  const projection = projectCommitted(source(input, shared), currentEntities);
  const candidate = overlayLocal(shared, projection.local, currentEntities);
  const afterDigest = digest(candidate, input.configPath);
  prepareLocalCommit(input.repo, input.bindingId, {
    commitId: `remote:${objectId}:${operationId}`,
    origin: 'remote',
    beforeDigest,
    afterDigest,
    rawAfter: candidate,
    accountOperationIds: [],
    remoteOperations: [{ objectId, operationId }],
    ...(secretChange === undefined
      ? {}
      : {
          pluginSecrets: [
            {
              plugin: secretChange.plugin,
              ...(previousSecret === null ? {} : { before: previousSecret.value as JsonValue }),
              ...(secretChange.value === undefined ? {} : { after: secretChange.value }),
            } satisfies PluginSecretCommit,
          ],
        }),
  });
  return {
    candidate,
    secretChange,
    previousSecret,
    configNeedsApply: true,
    shouldMutateSecret: true,
  };
}

// A prepared deletion whose configuration write already landed can be confirmed by startup recovery
// from the on-disk digest alone, before the account deletion and the ownership-clearing row write
// ever ran. Recovery re-checks the plugin-secret half before confirming, but nothing replays these:
// the shared account would outlive its deleted Provider and the stale ownership would pin
// `detach-required` on a tombstone that can never detach. Both writes below are idempotent.
function finishTombstone(
  input: LocalPortInput,
  currentEntity: ReturnType<SyncRepository['entities']>[number] | undefined,
): void {
  if (currentEntity?.mode !== 'included' || currentEntity.kind !== 'provider') return;
  input.accounts.deleteAccount(currentEntity.logicalKey);
  if (currentEntity.oauth === undefined) return;
  const { oauth: _oauth, ...cleared } = currentEntity;
  input.repo.putEntity(input.bindingId, cleared);
}

export function createLocalSyncPort(input: LocalPortInput): LocalSyncPort {
  const withFence = <T>(run: () => Promise<T>): Promise<T> => input.enqueue(run);
  const entities = () => input.entities?.() ?? input.repo.entities(input.bindingId);
  const assertCurrent = (): void => {
    const binding = input.repo.readBinding();
    if (
      binding === null ||
      binding.id !== input.bindingId ||
      (input.bindingGeneration !== undefined && binding.sessionGeneration !== input.bindingGeneration)
    ) {
      throw new Error('The synchronization binding is stale');
    }
  };

  return {
    withFence,
    async rawDigest() {
      return digest((await input.configFile.read()) as Record<string, JsonValue>, input.configPath);
    },
    accountOperationsSettled(ids) {
      const pending = new Set(input.accounts.listPendingAccountOperations().map((operation) => operation.operationId));
      return ids.every((id) => !pending.has(id));
    },
    async checkRemote(body, signal) {
      if (input.checkActivation === undefined) return undefined;
      return input.checkActivation((await input.configFile.read()) as Record<string, JsonValue>, body, signal);
    },
    async committedSource() {
      return source(input, (await input.configFile.read()) as Record<string, JsonValue>);
    },
    assertCurrent,
    async applyRemote(objectId, body, operationId, intent) {
      return withFence(async () => {
        const current = (await input.configFile.read()) as Record<string, JsonValue>;
        assertCurrent();
        const currentEntities = entities();
        const currentEntity = currentEntities.find((entity) => entity.objectId === objectId);
        const remoteCommitId = `remote:${objectId}:${operationId}`;
        const existingCommit = input.repo.readCommit(input.bindingId, remoteCommitId);
        if (existingCommit?.phase === 'confirmed') {
          if (body === null) finishTombstone(input, currentEntity);
          return { applied: true };
        }
        // A `sync leave` completing while the caller was still validating this body — the activation
        // check awaits the backend outside this fence — leaves the reconciliation pass holding a
        // snapshot that says `included`. Writing the body anyway would put the Provider's cloud
        // configuration back after Leave reported success. Excluded is exactly the state that pass
        // handles by acknowledging the revision without touching the configuration, so answer the
        // same way rather than revisiting the row on every later poll. A commit already prepared for
        // this revision is left to resolve: its write may be on disk, and its digest guard is what
        // decides whether anything is written at all.
        if (intent !== 'reviewed' && existingCommit === null && currentEntity?.mode === 'excluded')
          return { applied: true };

        const currentDigest = digest(current, input.configPath);
        let candidate: Record<string, JsonValue>;
        let secretChange: PluginSecretChange | undefined;
        let previousSecret: ReturnType<PluginRepository['readPluginSecret']> = null;
        let configNeedsApply: boolean;
        let shouldMutateSecret: boolean;

        if (existingCommit?.phase === 'prepared') {
          const prepared = resolvePreparedRemoteState(input, currentDigest, existingCommit);
          if ('pending' in prepared) return prepared;
          ({ candidate, secretChange, previousSecret, configNeedsApply, shouldMutateSecret } = prepared);
        } else {
          const prepared = prepareNewRemoteState(
            input,
            current,
            currentEntities,
            currentEntity,
            body,
            objectId,
            operationId,
            currentDigest,
          );
          assertCurrent();
          ({ candidate, secretChange, previousSecret, configNeedsApply, shouldMutateSecret } = prepared);
        }
        let secretChanged = false;
        try {
          if (shouldMutateSecret && secretChange !== undefined) {
            if (secretChange.value === undefined) {
              if (
                previousSecret !== null &&
                !input.accounts.deletePluginSecret(secretChange.plugin, previousSecret.revision)
              )
                return { applied: false, pending: 'secret-conflict' as const };
              secretChanged = previousSecret !== null;
            } else if (previousSecret === null || !isEqual(previousSecret.value, secretChange.value)) {
              input.accounts.writePluginSecret(
                secretChange.plugin,
                previousSecret?.revision ?? null,
                secretChange.value,
              );
              secretChanged = true;
            }
          }
          if (configNeedsApply || secretChanged)
            await input.applyCandidate(
              candidate,
              'remote',
              operationId,
              shouldMutateSecret ? secretChange : undefined,
              currentDigest,
            );
        } catch (error) {
          if (error instanceof AtomicConfigCommitUncertainError)
            return { applied: false, pending: 'invalid-config' as const };
          if (
            secretChanged &&
            secretChange !== undefined &&
            !restorePluginSecret(input.accounts, secretChange.plugin, previousSecret)
          )
            return { applied: false, pending: 'secret-conflict' as const };
          if (existingCommit?.phase !== 'prepared') input.repo.discard(input.bindingId, remoteCommitId);
          return { applied: false, pending: 'invalid-config' as const };
        }
        assertCurrent();
        const tombstoned =
          body === null && currentEntity?.mode === 'included' && currentEntity.kind === 'provider'
            ? currentEntity
            : undefined;
        if (tombstoned !== undefined) input.accounts.deleteAccount(tombstoned.logicalKey);
        // `currentEntities` predates the configuration write above. An override Apply runs outside
        // this fence, so replaying that snapshot would silently unpin paths it just persisted.
        const latestEntity = entities().find((entity) => entity.objectId === objectId);
        // Same for OAuth ownership: a shared credential refresh imports the rotated account and
        // records the revision it wrote on this row, outside the fence. Replaying the snapshot would
        // reinstate the older `localRevision`, and the next credential read rejects the Provider as
        // `detach-pending` because it disagrees with the stored account. A row that lost its
        // ownership meanwhile — a completed detach — must not have it resurrected either.
        const oauth = latestEntity === undefined ? currentEntity?.oauth : latestEntity.oauth;
        const nextEntity = {
          objectId,
          logicalKey:
            body?.logicalKey ?? currentEntities.find((entity) => entity.objectId === objectId)?.logicalKey ?? objectId,
          kind: body?.kind ?? currentEntities.find((entity) => entity.objectId === objectId)?.kind ?? 'provider',
          mode: currentEntities.find((entity) => entity.objectId === objectId)?.mode ?? 'included',
          epoch: currentEntities.find((entity) => entity.objectId === objectId)?.epoch ?? 0,
          desired: body,
          baseline: null,
          overrides: latestEntity?.overrides ?? currentEntity?.overrides ?? [],
          pendingReason: null,
          // The account this ownership names was just deleted, so carrying it onto the tombstone
          // would pin `detach-required` on a row that can never detach — and sharing would keep
          // seeing the stale ownership if the Provider is restored.
          ...(oauth === undefined || tombstoned !== undefined ? {} : { oauth }),
        };
        input.repo.putEntity(input.bindingId, nextEntity);
        await confirmLocalCommit(input.repo, input.bindingId, remoteCommitId, {
          withFence: async <T>(run: () => Promise<T>) => run(),
          rawDigest: async () => digest((await input.configFile.read()) as Record<string, JsonValue>, input.configPath),
          accountOperationsSettled: () => true,
          committedSource: async () => source(input, candidate),
          assertCurrent,
        });
        if (input.repo.readCommit(input.bindingId, remoteCommitId)?.phase !== 'confirmed') {
          if (currentEntity !== undefined) input.repo.putEntity(input.bindingId, currentEntity);
          return {
            applied: false,
            pending: secretChange === undefined ? ('invalid-config' as const) : ('secret-conflict' as const),
          };
        }
        return { applied: true };
      });
    },
  };
}

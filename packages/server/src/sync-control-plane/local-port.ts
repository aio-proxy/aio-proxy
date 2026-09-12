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

import type { ConfigStore } from '../config-store';
import type { FifoQueue } from '../fifo-queue';

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
  readonly checkActivation?: (raw: Record<string, JsonValue>, body: EntityBody) => Promise<PendingReason | undefined>;
  readonly entities?: () => ReturnType<SyncRepository['entities']>;
  readonly pluginVersions?: () => ReadonlyMap<string, string>;
};

function digest(raw: Record<string, JsonValue>, path: string): string {
  return createHash('sha256').update(encodeCandidate(raw, path)).digest('hex');
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function copyRaw(raw: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(raw)) as Record<string, JsonValue>;
}

// The allowlists projectCommitted publishes for these kinds. A shared body always carries the
// complete set, so a key the body omits was deleted on the other device and must be deleted here
// too — spreading the body would silently keep a revoked password or API key working.
const SERVICE_ACCESS_KEYS = ['apiKeys', 'password'] as const;
const ROUTING_DEFAULTS_SERVER_KEYS = ['retry'] as const;
const ROUTING_DEFAULTS_ROUTER_KEYS = ['modelContextAggregation'] as const;

function replaceKeys(
  target: Record<string, JsonValue>,
  value: Record<string, JsonValue>,
  keys: readonly string[],
): Record<string, JsonValue> {
  for (const key of keys) {
    if (Object.hasOwn(value, key)) target[key] = value[key]!;
    else delete target[key];
  }
  return target;
}

/**
 * A published model rule carries only the Providers the other device included, so installing or
 * deleting one verbatim would drop this device's routes to Providers it kept local. `projectCommitted`
 * re-derives the local remainder from the result, so a route lost here is lost for good. Returns
 * `undefined` when the rule holds nothing local and the shared portion is gone.
 */
function mergeLocalRoutes(
  previous: JsonValue | undefined,
  shared: JsonValue | undefined,
  entities: ReturnType<SyncRepository['entities']>,
): JsonValue | undefined {
  const included = new Set(
    entities.filter((entity) => entity.kind === 'provider' && entity.mode === 'included').map((e) => e.logicalKey),
  );
  const local = Object.entries(record(record(previous)['providers'])).filter(([id]) => !included.has(id));
  if (local.length === 0) return shared;
  const base = record(shared);
  return { ...base, providers: { ...record(base['providers']), ...Object.fromEntries(local) } };
}

function applyBody(
  raw: Record<string, JsonValue>,
  body: EntityBody | null,
  entities: ReturnType<SyncRepository['entities']>,
): Record<string, JsonValue> {
  const next = copyRaw(raw);
  if (body === null) return next;
  switch (body.kind) {
    case 'provider': {
      const providers = record(next['providers']);
      const previous = record(providers[body.logicalKey]);
      const value = record(body.value);
      // sharedProvider strips `proxy` before publishing, so it stays device-local. Replacing the
      // whole Provider on a remote revision would wipe the authored proxy and its URL credentials.
      providers[body.logicalKey] = Object.hasOwn(previous, 'proxy')
        ? { ...value, proxy: previous['proxy']! }
        : body.value;
      next['providers'] = providers;
      break;
    }
    case 'model-rule': {
      const router = record(next['router']);
      const models = record(router['models']);
      models[body.logicalKey] = mergeLocalRoutes(models[body.logicalKey], body.value, entities) ?? body.value;
      router['models'] = models;
      next['router'] = router;
      break;
    }
    case 'plugin-business': {
      const plugins = Array.isArray(next['plugins']) ? [...next['plugins']] : [];
      const index = plugins.findIndex((entry) => {
        if (typeof entry === 'string') return entry === body.logicalKey;
        return Array.isArray(entry) && entry[0] === body.logicalKey;
      });
      const value = record(body.value);
      const options = value['options'];
      const entry = options === undefined ? body.logicalKey : [body.logicalKey, options];
      if (index < 0) plugins.push(entry);
      else plugins[index] = entry;
      next['plugins'] = plugins as JsonValue;
      break;
    }
    case 'service-access': {
      next['server'] = replaceKeys(record(next['server']), record(body.value), SERVICE_ACCESS_KEYS);
      break;
    }
    case 'routing-defaults': {
      const value = record(body.value);
      next['server'] = replaceKeys(record(next['server']), value, ROUTING_DEFAULTS_SERVER_KEYS);
      next['router'] = replaceKeys(record(next['router']), value, ROUTING_DEFAULTS_ROUTER_KEYS);
      break;
    }
  }
  return next;
}

function removeBody(
  raw: Record<string, JsonValue>,
  entity: ReturnType<SyncRepository['entities']>[number],
  entities: ReturnType<SyncRepository['entities']>,
): Record<string, JsonValue> {
  const next = copyRaw(raw);
  switch (entity.kind) {
    case 'provider': {
      const providers = record(next['providers']);
      delete providers[entity.logicalKey];
      next['providers'] = providers;
      break;
    }
    case 'model-rule': {
      const router = record(next['router']);
      const models = record(router['models']);
      const kept = mergeLocalRoutes(models[entity.logicalKey], undefined, entities);
      if (kept === undefined) delete models[entity.logicalKey];
      else models[entity.logicalKey] = kept;
      router['models'] = models;
      next['router'] = router;
      break;
    }
    case 'plugin-business': {
      if (Array.isArray(next['plugins'])) {
        next['plugins'] = next['plugins'].filter((entry) => {
          const name = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : undefined;
          return name !== entity.logicalKey;
        });
      }
      break;
    }
    case 'service-access': {
      next['server'] = replaceKeys(record(next['server']), {}, SERVICE_ACCESS_KEYS);
      break;
    }
    case 'routing-defaults': {
      next['server'] = replaceKeys(record(next['server']), {}, ROUTING_DEFAULTS_SERVER_KEYS);
      next['router'] = replaceKeys(record(next['router']), {}, ROUTING_DEFAULTS_ROUTER_KEYS);
      break;
    }
  }
  return next;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function secretMatches(snapshot: ReturnType<PluginRepository['readPluginSecret']>, expected: JsonValue | undefined) {
  return expected === undefined
    ? snapshot === null
    : snapshot !== null && sameJson(snapshot.value as JsonValue, expected);
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
  if (sameJson(current.value, previous.value)) return true;
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
    async checkRemote(body) {
      if (input.checkActivation === undefined) return undefined;
      return input.checkActivation((await input.configFile.read()) as Record<string, JsonValue>, body);
    },
    async committedSource() {
      return source(input, (await input.configFile.read()) as Record<string, JsonValue>);
    },
    assertCurrent,
    async applyRemote(objectId, body, operationId) {
      return withFence(async () => {
        const current = (await input.configFile.read()) as Record<string, JsonValue>;
        assertCurrent();
        const currentEntities = entities();
        const currentEntity = currentEntities.find((entity) => entity.objectId === objectId);
        const remoteCommitId = `remote:${objectId}:${operationId}`;
        const existingCommit = input.repo.readCommit(input.bindingId, remoteCommitId);
        if (existingCommit?.phase === 'confirmed') return { applied: true };

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
            } else if (previousSecret === null || !sameJson(previousSecret.value, secretChange.value)) {
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
        if (body === null && currentEntity?.mode === 'included' && currentEntity.kind === 'provider') {
          input.accounts.deleteAccount(currentEntity.logicalKey);
        }
        const nextEntity = {
          objectId,
          logicalKey:
            body?.logicalKey ?? currentEntities.find((entity) => entity.objectId === objectId)?.logicalKey ?? objectId,
          kind: body?.kind ?? currentEntities.find((entity) => entity.objectId === objectId)?.kind ?? 'provider',
          mode: currentEntities.find((entity) => entity.objectId === objectId)?.mode ?? 'included',
          epoch: currentEntities.find((entity) => entity.objectId === objectId)?.epoch ?? 0,
          desired: body,
          baseline: null,
          overrides: currentEntities.find((entity) => entity.objectId === objectId)?.overrides ?? [],
          pendingReason: null,
          ...(currentEntity?.oauth === undefined ? {} : { oauth: currentEntity.oauth }),
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

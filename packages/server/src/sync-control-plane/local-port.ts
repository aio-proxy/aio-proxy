import { createHash } from 'node:crypto';

import {
  type CommittedSource,
  type EntityBody,
  type LocalSyncPort,
  type PluginRegistry,
  type PluginRepository,
  type SyncRepository,
  encodeCandidate,
  overlayLocal,
  projectCommitted,
} from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';

import type { ConfigStore } from '../config-store';
import type { FifoQueue } from '../fifo-queue';

type ConfigFile = NonNullable<ConfigStore['file']>;

export type LocalPortInput = {
  readonly configPath: string;
  readonly configFile: ConfigFile;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly bindingId: string;
  readonly enqueue: FifoQueue;
  readonly registry: () => PluginRegistry;
  readonly applyCandidate: (raw: Record<string, JsonValue>, origin: 'local' | 'remote') => Promise<void>;
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

function applyBody(raw: Record<string, JsonValue>, body: EntityBody | null): Record<string, JsonValue> {
  const next = copyRaw(raw);
  if (body === null) return next;
  switch (body.kind) {
    case 'provider':
      next['providers'] = { ...record(next['providers']), [body.logicalKey]: body.value };
      break;
    case 'model-rule': {
      const router = record(next['router']);
      router['models'] = { ...record(router['models']), [body.logicalKey]: body.value };
      next['router'] = router;
      break;
    }
    case 'plugin-business': {
      const plugins = Array.isArray(next['plugins']) ? [...next['plugins']] : [];
      const index = plugins.findIndex((entry) => {
        if (typeof entry === 'string') return entry === body.logicalKey;
        return Array.isArray(entry) && entry[0] === body.logicalKey;
      });
      const value = body.value;
      if (index < 0) plugins.push(value);
      else plugins[index] = value;
      next['plugins'] = plugins as JsonValue;
      break;
    }
    case 'service-access': {
      next['server'] = { ...record(next['server']), ...record(body.value) };
      break;
    }
    case 'routing-defaults': {
      next['server'] = { ...record(next['server']), ...record(body.value) };
      break;
    }
  }
  return next;
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

export function createLocalSyncPort(input: LocalPortInput): LocalSyncPort {
  const withFence = <T>(run: () => Promise<T>): Promise<T> => input.enqueue(run);
  const entities = () => input.entities?.() ?? input.repo.entities(input.bindingId);

  return {
    withFence,
    async rawDigest() {
      return digest((await input.configFile.read()) as Record<string, JsonValue>, input.configPath);
    },
    accountOperationsSettled(ids) {
      const pending = new Set(input.accounts.listPendingAccountOperations().map((operation) => operation.operationId));
      return ids.every((id) => !pending.has(id));
    },
    async committedSource() {
      return source(input, (await input.configFile.read()) as Record<string, JsonValue>);
    },
    assertCurrent() {
      const binding = input.repo.readBinding();
      if (binding === null || binding.id !== input.bindingId) throw new Error('The synchronization binding is stale');
    },
    async applyRemote(objectId, body) {
      return withFence(async () => {
        const current = (await input.configFile.read()) as Record<string, JsonValue>;
        const currentEntities = entities();
        const shared = applyBody(current, body);
        const projection = projectCommitted(source(input, shared), currentEntities);
        const candidate = overlayLocal(shared, projection.local, currentEntities);
        await input.applyCandidate(candidate, 'remote');
        input.repo.putEntity(input.bindingId, {
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
        });
        return { applied: true };
      });
    },
  };
}

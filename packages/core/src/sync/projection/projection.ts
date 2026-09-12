import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { StoredAccount } from '../../plugins/repository';
import type { EntityBody, Dependency } from '../protocol';
import { providerReference } from '../protocol';
import type { LocalEntity } from '../repository';
import { applyEntityOverrides, applyOverrides, cloneJson, mergeRaw, overlayEntityOverrides } from './local-overrides';
import { localModelPolicy, selectedModelPolicy } from './model-overlays';

type JsonRecord = Record<string, JsonValue>;

export interface CommittedSource {
  raw: Record<string, JsonValue>;
  accounts: ReadonlyMap<string, StoredAccount>;
  pluginSecrets: ReadonlyMap<string, unknown>;
  pluginVersions: ReadonlyMap<string, string>;
  sourceRevisions?: Readonly<Record<string, number>>;
}

export interface Projection {
  entities: Map<string, EntityBody>;
  accounts: Map<string, StoredAccount>;
  local: Record<string, JsonValue>;
}

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== undefined && isPlainObject(value) ? (value as JsonRecord) : undefined;
}

function recordAt(root: Record<string, JsonValue>, ...path: string[]): JsonRecord {
  let value: JsonValue | undefined = root;
  for (const segment of path) value = asRecord(value)?.[segment];
  return asRecord(value) ?? {};
}

function own(value: JsonRecord | undefined, key: string): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

// `__proto__` is a valid Provider ID and model name, and a plain assignment for that key invokes the
// prototype setter instead of creating an own property, silently dropping the entry.
function setKey(target: JsonRecord, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function identityKey(kind: LocalEntity['kind'], logicalKey: string): string {
  return `${kind}\0${logicalKey}`;
}

function entityIndex(entities: readonly LocalEntity[]): Map<string, LocalEntity> {
  return new Map(entities.map((entity) => [identityKey(entity.kind, entity.logicalKey), entity]));
}

function includedProviderIds(entities: readonly LocalEntity[]): Set<string> {
  return new Set(
    entities
      .filter((entity) => entity.kind === 'provider' && entity.mode === 'included')
      .map((entity) => entity.logicalKey),
  );
}

function packageDependency(
  packageName: string,
  identities: ReadonlyMap<string, LocalEntity>,
  versions: ReadonlyMap<string, string>,
): Dependency | undefined {
  const identity = identities.get(identityKey('plugin-business', packageName));
  const version = versions.get(packageName);
  if (identity?.mode !== 'included' || version === undefined) return undefined;
  return { objectId: identity.objectId, packageName, version };
}

function providerDependency(
  provider: JsonRecord,
  identities: ReadonlyMap<string, LocalEntity>,
  versions: ReadonlyMap<string, string>,
): Dependency | null | undefined {
  const packageName =
    provider['kind'] === 'oauth'
      ? provider['plugin']
      : provider['kind'] === 'ai-sdk'
        ? provider['packageName']
        : undefined;
  if (typeof packageName !== 'string') return null;
  const dependency = packageDependency(packageName, identities, versions);
  // An AI SDK provider package is not a plugin: it has no descriptor, no settings and no registry
  // version, and `plugin add` deliberately keeps it out of the `plugins` array. Requiring an object
  // for it would drop the Provider from the projection and publish nothing at all. A package the
  // user did list in `plugins` keeps the strict gate, and so does every OAuth Provider — another
  // device cannot verify its credential without the plugin version the body names. The receiving
  // device resolves the package on first use, so a missing one surfaces there as a provider error.
  if (dependency === undefined && provider['kind'] === 'ai-sdk')
    return identities.has(identityKey('plugin-business', packageName)) ? undefined : null;
  return dependency;
}

/**
 * The business plugin package an authored Provider needs, read from the configuration rather than
 * from a published body. A Provider that is not yet selected has no body, so a join has to learn
 * its dependency from here before the projection can produce one.
 */
export function providerDependencyPackage(raw: Record<string, JsonValue>, providerId: string): string | undefined {
  const provider = asRecord(recordAt(raw, 'providers')[providerId]);
  if (provider === undefined) return undefined;
  const packageName =
    provider['kind'] === 'oauth'
      ? provider['plugin']
      : provider['kind'] === 'ai-sdk'
        ? provider['packageName']
        : undefined;
  return typeof packageName === 'string' ? packageName : undefined;
}

function sharedProvider(value: JsonValue): JsonValue {
  const provider = asRecord(value);
  if (provider === undefined) return cloneJson(value);
  const { proxy: _proxy, ...business } = provider;
  return cloneJson(business);
}

function pluginEntry(value: JsonValue): { packageName: string; options?: JsonValue } | undefined {
  if (typeof value === 'string') return { packageName: value };
  if (!Array.isArray(value) || typeof value[0] !== 'string') return undefined;
  return { packageName: value[0], ...(value.length > 1 ? { options: cloneJson(value[1]) } : {}) };
}

function pluginEntries(raw: JsonValue | undefined): Map<string, { packageName: string; options?: JsonValue }> {
  const result = new Map<string, { packageName: string; options?: JsonValue }>();
  if (!Array.isArray(raw)) return result;
  for (const item of raw) {
    const entry = pluginEntry(item);
    if (entry !== undefined) result.set(entry.packageName, entry);
  }
  return result;
}

function authoredPluginValue(packageName: string, value: JsonValue): JsonValue {
  if (typeof value === 'string') return packageName;
  if (Array.isArray(value)) {
    const entry = pluginEntry(value);
    return entry?.options === undefined ? packageName : [packageName, cloneJson(entry.options)];
  }
  const record = asRecord(value);
  if (record !== undefined) {
    if (Object.hasOwn(record, 'packageName') && !Object.hasOwn(record, 'options')) return packageName;
    const options = Object.hasOwn(record, 'options') ? record['options'] : record;
    return options === undefined ? packageName : [packageName, cloneJson(options)];
  }
  return [packageName, cloneJson(value)];
}

function overlayPluginOverrides(
  plugins: JsonValue | undefined,
  packageName: string,
  overrides: LocalEntity['overrides'],
): JsonValue | undefined {
  if (!Array.isArray(plugins)) return plugins;
  const result = cloneJson(plugins) as JsonValue[];
  const index = result.findIndex((entry) => pluginEntry(entry)?.packageName === packageName);
  if (index < 0) return result;
  const candidate = result[index];
  if (candidate === undefined) return result;
  const entry = pluginEntry(candidate);
  if (entry === undefined) return result;
  const value: JsonValue = {
    packageName,
    ...(entry.options === undefined ? {} : { options: cloneJson(entry.options) }),
  };
  let updated: JsonValue = value;
  for (const override of overrides) {
    if (override.path.length === 0) {
      if (override.value === undefined) {
        result.splice(index, 1);
        return result;
      }
      updated = cloneJson(override.value);
    } else {
      updated = applyOverrides(updated, [override]);
    }
  }
  result[index] = authoredPluginValue(packageName, updated);
  return result;
}

function pluginValue(
  entry: { packageName: string; options?: JsonValue } | undefined,
  packageName: string,
  version: string,
  secret: unknown,
  hasSecret: boolean,
): JsonValue {
  return {
    packageName,
    version,
    ...(entry?.options === undefined ? {} : { options: cloneJson(entry.options) }),
    ...(hasSecret ? { secret: cloneJson(secret) } : {}),
  };
}

function accountCopy(account: StoredAccount): StoredAccount {
  return {
    ...account,
    options: cloneJson(account.options),
    secrets: cloneJson(account.secrets),
    credential: cloneJson(account.credential),
  };
}

function entityBody(entity: LocalEntity, value: JsonValue, dependencies: Dependency[] = []): EntityBody {
  return {
    kind: entity.kind,
    logicalKey: entity.logicalKey,
    value: publishedValue(value, entity),
    dependencies,
  };
}

/**
 * The shared body for an entity. An overridden path holds a machine-local decision, so it is
 * excluded from what is published whether or not the override carries a value; `overlayLocal` puts
 * the local value back on activation. A root override leaves no publishable remainder, so the
 * authored value is published unchanged rather than the local replacement.
 */
function publishedValue(value: JsonValue, entity: LocalEntity): JsonValue {
  let result = cloneJson(value);
  for (const override of entity.overrides) {
    if (override.path.length === 0 || !isPlainObject(result)) continue;
    const pathRoot = { value: result };
    applyEntityOverrides(pathRoot, ['value'], [{ path: override.path, value: undefined }]);
    result = pathRoot.value;
  }
  return result;
}

function localProjection(
  source: CommittedSource,
  entities: readonly LocalEntity[],
  selected: ReadonlySet<string>,
): JsonRecord {
  const raw = source.raw;
  const local = cloneJson(raw) as JsonRecord;
  const providers = recordAt(raw, 'providers');
  const localProviders: JsonRecord = {};
  for (const [providerId, value] of Object.entries(providers)) {
    const entity = entities.find((candidate) => candidate.kind === 'provider' && candidate.logicalKey === providerId);
    if (entity?.mode === 'included') {
      const provider = asRecord(value);
      if (own(provider, 'proxy')) setKey(localProviders, providerId, { proxy: cloneJson(provider!['proxy']) });
    } else {
      setKey(localProviders, providerId, cloneJson(value));
    }
  }
  if (own(raw, 'providers')) local['providers'] = localProviders;

  const models = recordAt(raw, 'router', 'models');
  const localModels: JsonRecord = {};
  for (const [model, value] of Object.entries(models)) {
    const entity = entities.find((candidate) => candidate.kind === 'model-rule' && candidate.logicalKey === model);
    if (entity?.mode === 'included') {
      const partial = localModelPolicy(value, selected);
      if (partial !== undefined) setKey(localModels, model, partial);
    } else {
      setKey(localModels, model, cloneJson(value));
    }
  }
  const router = asRecord(local['router']) ?? {};
  router['models'] = localModels;
  if (own(raw, 'router')) local['router'] = router;

  const plugins = pluginEntries(raw['plugins']);
  const localPlugins: JsonValue[] = [];
  for (const [packageName, entry] of plugins) {
    const entity = entities.find(
      (candidate) => candidate.kind === 'plugin-business' && candidate.logicalKey === packageName,
    );
    if (entity?.mode !== 'included') {
      localPlugins.push(entry.options === undefined ? packageName : [packageName, cloneJson(entry.options)]);
    }
  }
  if (own(raw, 'plugins')) local['plugins'] = localPlugins;

  const server = asRecord(local['server']) ?? {};
  if (entities.some((entity) => entity.kind === 'service-access' && entity.mode === 'included')) {
    delete server['apiKeys'];
    delete server['password'];
  }
  if (entities.some((entity) => entity.kind === 'routing-defaults' && entity.mode === 'included'))
    delete server['retry'];
  if (own(raw, 'server')) local['server'] = server;
  if (
    own(raw, 'router') &&
    entities.some((entity) => entity.kind === 'routing-defaults' && entity.mode === 'included')
  ) {
    const localRouter = asRecord(local['router']) ?? {};
    delete localRouter['modelContextAggregation'];
    local['router'] = localRouter;
  }
  return local;
}

export function projectCommitted(source: CommittedSource, entities: readonly LocalEntity[]): Projection {
  const index = entityIndex(entities);
  const selectedProviders = includedProviderIds(entities);
  const rawProviders = recordAt(source.raw, 'providers');
  const rawModels = recordAt(source.raw, 'router', 'models');
  const pluginMap = pluginEntries(source.raw['plugins']);
  const businessPluginPackages = new Set(pluginMap.keys());
  for (const entity of entities) {
    if (entity.kind !== 'provider' || entity.mode !== 'included') continue;
    const provider = asRecord(rawProviders[entity.logicalKey]);
    if (provider?.['kind'] === 'oauth' && typeof provider['plugin'] === 'string') {
      businessPluginPackages.add(provider['plugin']);
    }
  }
  const entitiesOut = new Map<string, EntityBody>();
  const accountsOut = new Map<string, StoredAccount>();

  for (const entity of entities) {
    if (entity.mode !== 'included') continue;
    let value: JsonValue | undefined;
    let dependencies: Dependency[] = [];
    if (entity.kind === 'provider') {
      const provider = asRecord(rawProviders[entity.logicalKey]);
      if (provider === undefined) continue;
      const account = provider['kind'] === 'oauth' ? source.accounts.get(entity.logicalKey) : undefined;
      if (provider['kind'] === 'oauth' && account === undefined) continue;
      const dependency = providerDependency(provider, index, source.pluginVersions);
      if (dependency === undefined) continue;
      value = sharedProvider(provider);
      dependencies = dependency === null ? [] : [dependency];
      if (account !== undefined) accountsOut.set(entity.objectId, accountCopy(account));
    } else if (entity.kind === 'model-rule') {
      // A model name is user data, so a published rule can be named `toString`. Reading it without an
      // own check resolves the prototype's function once the rule is deleted from the configuration,
      // and projecting that throws instead of emitting the deletion the commit needs.
      if (!own(rawModels, entity.logicalKey)) continue;
      const model = rawModels[entity.logicalKey];
      if (model === undefined) continue;
      value = selectedModelPolicy(model, selectedProviders);
      const refs = asRecord(asRecord(model)?.['providers']);
      dependencies = Object.keys(refs ?? {})
        .map((providerId) => index.get(identityKey('provider', providerId)))
        .filter((provider): provider is LocalEntity => provider?.mode === 'included')
        .map(providerReference);
    } else if (entity.kind === 'plugin-business') {
      const version = source.pluginVersions.get(entity.logicalKey);
      if (version === undefined) continue;
      const secretPresent =
        businessPluginPackages.has(entity.logicalKey) && source.pluginSecrets.has(entity.logicalKey);
      value = pluginValue(
        pluginMap.get(entity.logicalKey),
        entity.logicalKey,
        version,
        source.pluginSecrets.get(entity.logicalKey),
        secretPresent,
      );
    } else if (entity.kind === 'service-access') {
      const server = recordAt(source.raw, 'server');
      value = Object.fromEntries(
        ['apiKeys', 'password'].filter((key) => own(server, key)).map((key) => [key, cloneJson(server[key])]),
      );
    } else if (entity.kind === 'routing-defaults') {
      const server = recordAt(source.raw, 'server');
      const router = recordAt(source.raw, 'router');
      value = Object.fromEntries(
        [
          ['retry', server['retry']],
          ['modelContextAggregation', router['modelContextAggregation']],
        ]
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, cloneJson(item)]),
      );
    }
    if (value !== undefined) entitiesOut.set(entity.objectId, entityBody(entity, value, dependencies));
  }
  return { entities: entitiesOut, accounts: accountsOut, local: localProjection(source, entities, selectedProviders) };
}

function entityPath(entity: LocalEntity, overridePath: readonly string[]): string[] {
  switch (entity.kind) {
    case 'provider':
      return ['providers', entity.logicalKey];
    case 'model-rule':
      return ['router', 'models', entity.logicalKey];
    case 'plugin-business':
      return ['plugins'];
    case 'service-access':
      return ['server'];
    case 'routing-defaults':
      // The published body is flat, but `retry` is authored under `server` while
      // `modelContextAggregation` is authored under `router`. Sending both to one section writes the
      // pinned value to a key nothing reads and leaves the remote value active.
      return [overridePath[0] === 'retry' ? 'server' : 'router'];
  }
}

export function overlayLocal(
  sharedRaw: Record<string, JsonValue>,
  localRaw: Record<string, JsonValue>,
  entities: readonly LocalEntity[],
): Record<string, JsonValue> {
  let result = mergeRaw(sharedRaw, localRaw);
  const localPlugins = pluginEntries(localRaw['plugins']);
  if (localRaw['plugins'] !== undefined) {
    const sharedPlugins = pluginEntries(sharedRaw['plugins']);
    for (const [packageName, entry] of localPlugins) sharedPlugins.set(packageName, entry);
    result['plugins'] = [...sharedPlugins.values()].map((entry) =>
      entry.options === undefined ? entry.packageName : [entry.packageName, cloneJson(entry.options)],
    );
  }
  for (const entity of entities) {
    if (entity.kind === 'plugin-business') {
      const plugins = overlayPluginOverrides(result['plugins'], entity.logicalKey, entity.overrides);
      if (plugins !== undefined) result['plugins'] = plugins;
    } else {
      for (const override of entity.overrides)
        overlayEntityOverrides(result, entityPath(entity, override.path), [override]);
    }
  }
  return result;
}

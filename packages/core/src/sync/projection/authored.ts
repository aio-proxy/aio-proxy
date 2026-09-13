import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { PluginRepository } from '../../plugins/repository';
import type { EntityKind } from '../protocol';
import { isTombstonedEntity, type LocalEntity, type SyncRepository } from '../repository';
import type { CommittedSource } from './projection';

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== undefined && isPlainObject(value) ? (value as Record<string, JsonValue>) : undefined;
}

function pluginPackages(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : undefined;
    return typeof name === 'string' ? [name] : [];
  });
}

function oauthProviderPackages(value: JsonValue | undefined): string[] {
  const providers = record(value);
  if (providers === undefined) return [];
  return Object.values(providers).flatMap((provider) => {
    const entry = record(provider);
    return entry?.['kind'] === 'oauth' && typeof entry['plugin'] === 'string' ? [entry['plugin']] : [];
  });
}

/**
 * Every plugin package the configuration requires: those listed in `plugins`, plus the one an OAuth
 * Provider names. `aio-proxy login` writes only the Provider entry, so its plugin never reaches the
 * `plugins` array — and without an object of its own there is nothing for the Provider to depend on,
 * which drops the Provider from the projection and publishes neither its configuration nor its
 * account.
 */
export function authoredPluginPackages(raw: Record<string, JsonValue>): Set<string> {
  return new Set([...pluginPackages(raw['plugins']), ...oauthProviderPackages(raw['providers'])]);
}

/**
 * Every object the authored configuration declares, as (kind, logicalKey) identities. This is the
 * inverse of the authored-object check used to detect deletions, so the two must agree: an identity
 * listed here becomes a selectable local row, and one omitted here reads as an authored removal.
 */
export function authoredEntityIdentities(
  raw: Record<string, JsonValue>,
): { readonly kind: EntityKind; readonly logicalKey: string }[] {
  const identities: { kind: EntityKind; logicalKey: string }[] = [];
  for (const providerId of Object.keys(record(raw['providers']) ?? {}))
    identities.push({ kind: 'provider', logicalKey: providerId });
  for (const model of Object.keys(record(record(raw['router'])?.['models']) ?? {}))
    identities.push({ kind: 'model-rule', logicalKey: model });
  for (const packageName of authoredPluginPackages(raw))
    identities.push({ kind: 'plugin-business', logicalKey: packageName });
  // The two singleton kinds have no authored key of their own, so they use their kind as the
  // logical key — the same identity the published head carries.
  if (Object.hasOwn(raw, 'server')) identities.push({ kind: 'service-access', logicalKey: 'service-access' });
  if (Object.hasOwn(raw, 'server') || Object.hasOwn(raw, 'router'))
    identities.push({ kind: 'routing-defaults', logicalKey: 'routing-defaults' });
  return identities;
}

/**
 * The local half of what a projection reads: the authored file plus the device-local stores the
 * bodies are built from. Callers that hold a bound `LocalSyncPort` get this from the port; a first
 * connect has no port yet and builds it here, so the connect preview projects the same bodies the
 * commit path would rather than a second encoding of them.
 */
export function committedSourceFrom(
  raw: Record<string, JsonValue>,
  accounts: Pick<PluginRepository, 'readAccount' | 'readPluginSecret'>,
  pluginVersions: ReadonlyMap<string, string> = new Map(),
): CommittedSource {
  const stored = new Map(
    Object.keys(record(raw['providers']) ?? {})
      .map((providerId) => [providerId, accounts.readAccount(providerId)] as const)
      .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null),
  );
  const secrets = new Map(
    // Every plugin the configuration requires, not only those listed in `plugins`: the projection
    // publishes the business secret of a plugin an OAuth Provider names, and `aio-proxy login`
    // writes no `plugins` entry for it. Omitting it here publishes the Provider without the secret
    // another device needs to use it.
    [...authoredPluginPackages(raw)]
      .map((plugin) => [plugin, accounts.readPluginSecret(plugin)?.value] as const)
      .filter((entry) => entry[1] !== undefined),
  );
  return { raw, accounts: stored, pluginSecrets: secrets, pluginVersions };
}

/**
 * Creates the missing local rows for authored objects so they can be selected, excluded and shown
 * in status. Authored objects are local-only until an explicit join, so every new row is excluded
 * and nothing is published by seeding. Rows that already exist are never touched: their mode,
 * overrides and baseline are user and protocol state.
 */
export function seedAuthoredEntities(
  repo: SyncRepository,
  bindingId: string,
  raw: Record<string, JsonValue>,
  /**
   * Identities that already exist on the cloud side of a connect the caller is still applying. Those
   * rows arrive under the cloud object's own ID once the reviewed decisions land, so seeding one here
   * too would leave two rows for one kind and logical key — which the first reconciliation reports as
   * an identity conflict between the authored object and its own cloud copy.
   */
  reserved: readonly { readonly kind: string; readonly logicalKey: string }[] = [],
): LocalEntity[] {
  const existing = new Set(
    [
      // A tombstone keeps its kind and logical key for credential coordination but no longer holds
      // that identity, so re-authoring the object is a new object. Counting it here hands the
      // re-created configuration the deleted head's row: the commit queues a put the engine drops
      // against the tombstone, and reconciliation reads the recorded `deleted:` baseline as already
      // applied — the row stays included, and nothing is ever published.
      ...repo.entities(bindingId).filter((entity) => !isTombstonedEntity(entity)),
      ...reserved,
    ].map((entity) => `${entity.kind}\0${entity.logicalKey}`),
  );
  const seeded: LocalEntity[] = [];
  for (const identity of authoredEntityIdentities(raw)) {
    const key = `${identity.kind}\0${identity.logicalKey}`;
    if (existing.has(key)) continue;
    existing.add(key);
    seeded.push({
      objectId: crypto.randomUUID(),
      logicalKey: identity.logicalKey,
      kind: identity.kind,
      mode: 'excluded',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    });
  }
  if (seeded.length === 0) return seeded;
  if (repo.putEntities !== undefined) repo.putEntities(bindingId, seeded);
  else for (const entity of seeded) repo.putEntity(bindingId, entity);
  return seeded;
}

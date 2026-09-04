import { digestProviderEntry, resolveConfigTemplates } from '@aio-proxy/core';
import { ConfigSchema, type DashboardProviderRoutingMutation } from '@aio-proxy/types';
import { mapValues } from 'es-toolkit/object';
import { isPlainObject } from 'es-toolkit/predicate';

export class ProviderRoutingStaleRevisionError extends Error {
  constructor() {
    super('stale_revision');
    this.name = 'ProviderRoutingStaleRevisionError';
  }
}

export class ProviderRoutingSetChangedError extends Error {
  constructor() {
    super('provider_set_changed');
    this.name = 'ProviderRoutingSetChangedError';
  }
}

/**
 * The Provider IDs the parser accepts from an authored providers record.
 *
 * Derived from the record itself, not the running config: the watcher's snapshot lags an external
 * edit, so a Provider added on disk between the client's GET and the reload would otherwise be
 * absent from both the expected set and the revision, and a save would silently omit it.
 *
 * Templates are resolved first, the same way the runtime loads the file: a `{{env.NAME}}` baseURL is
 * not a valid authored shape on its own, so parsing the raw record would drop every templated
 * Provider from the set the board is built from and reject every save. Resolution is per entry so an
 * unparseable template only disqualifies its own Provider.
 */
export const validProviderIds = (providers: Readonly<Record<string, unknown>>): string[] => {
  const resolved = mapValues(providers, (entry) => {
    try {
      return resolveConfigTemplates(entry);
    } catch {
      return entry;
    }
  });
  const parsed = ConfigSchema.safeParse({ providers: resolved });
  return parsed.success ? parsed.data.providers.map((provider) => provider.id) : [];
};

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort((left, right) => left.localeCompare(right));

const routingSnapshot = (
  providers: Readonly<Record<string, unknown>>,
  providerIds: readonly string[],
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    sortedIds(providerIds).map((id) => {
      const raw = providers[id];
      if (!isPlainObject(raw)) return [id, null];
      return [
        id,
        {
          ...(raw['priority'] === undefined ? {} : { priority: raw['priority'] }),
          ...(raw['weight'] === undefined ? {} : { weight: raw['weight'] }),
        },
      ];
    }),
  );

export const providerRoutingRevision = (
  providers: Readonly<Record<string, unknown>>,
  providerIds: readonly string[],
): string => digestProviderEntry(routingSnapshot(providers, providerIds));

export const applyProviderRoutingMutation = (
  current: Record<string, unknown>,
  input: DashboardProviderRoutingMutation,
  providerIds: readonly string[],
): Record<string, unknown> => {
  // Membership is checked before the revision because the revision also covers membership: a Provider
  // that appeared since the client loaded the board would otherwise be reported as a stale revision,
  // hiding the fact that the submitted layout is missing an entry.
  const submittedIds = sortedIds(Object.keys(input.providers));
  const expectedIds = sortedIds(providerIds);
  if (submittedIds.length !== expectedIds.length || submittedIds.some((id, index) => id !== expectedIds[index])) {
    throw new ProviderRoutingSetChangedError();
  }

  if (providerRoutingRevision(current, providerIds) !== input.revision) {
    throw new ProviderRoutingStaleRevisionError();
  }

  return Object.fromEntries(
    Object.entries(current).map(([id, value]) => {
      const routing = input.providers[id];
      if (routing === undefined) return [id, value];
      if (!isPlainObject(value)) throw new ProviderRoutingSetChangedError();
      return [id, { ...value, priority: routing.priority, weight: routing.weight }];
    }),
  );
};

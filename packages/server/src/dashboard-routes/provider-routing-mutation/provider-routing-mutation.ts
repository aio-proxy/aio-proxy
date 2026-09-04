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

/** Effective routing values of one Provider: what the revision covers and what a save replaces. */
export interface ProviderRoutingValues {
  readonly id: string;
  readonly priority: number;
  readonly weight: number;
}

export const providerRoutingValues = (provider: ProviderRoutingValues): ProviderRoutingValues => ({
  id: provider.id,
  priority: provider.priority,
  weight: provider.weight,
});

/**
 * Effective routing values of every Provider the parser accepts from an authored providers record.
 *
 * Values are the parsed ones, not the authored ones, so a record whose entry omits `weight` digests
 * the same as the running config that defaulted it — the revision has to be comparable across the two
 * places it is derived: the runtime snapshot the dashboard reads and the file a save commits.
 *
 * Templates are resolved first, the same way the runtime loads the file: a `{{env.NAME}}` baseURL is
 * not a valid authored shape on its own, so parsing the raw record would drop every templated
 * Provider from the set the board is built from and reject every save. Resolution is per entry so an
 * unparseable template only disqualifies its own Provider.
 */
export const authoredProviderRouting = (providers: Readonly<Record<string, unknown>>): ProviderRoutingValues[] => {
  const resolved = mapValues(providers, (entry) => {
    try {
      return resolveConfigTemplates(entry);
    } catch {
      return entry;
    }
  });
  const parsed = ConfigSchema.safeParse({ providers: resolved });
  return parsed.success ? parsed.data.providers.map(providerRoutingValues) : [];
};

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort((left, right) => left.localeCompare(right));

export const providerRoutingRevision = (routing: readonly ProviderRoutingValues[]): string =>
  digestProviderEntry(
    Object.fromEntries(
      [...routing]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((provider) => [provider.id, { priority: provider.priority, weight: provider.weight }]),
    ),
  );

export const applyProviderRoutingMutation = (
  current: Record<string, unknown>,
  input: DashboardProviderRoutingMutation,
  routing: readonly ProviderRoutingValues[],
): Record<string, unknown> => {
  // Membership is checked before the revision because the revision also covers membership: a Provider
  // that appeared since the client loaded the board would otherwise be reported as a stale revision,
  // hiding the fact that the submitted layout is missing an entry.
  const submittedIds = sortedIds(Object.keys(input.providers));
  const expectedIds = sortedIds(routing.map((provider) => provider.id));
  if (submittedIds.length !== expectedIds.length || submittedIds.some((id, index) => id !== expectedIds[index])) {
    throw new ProviderRoutingSetChangedError();
  }

  if (providerRoutingRevision(routing) !== input.revision) {
    throw new ProviderRoutingStaleRevisionError();
  }

  return Object.fromEntries(
    Object.entries(current).map(([id, value]) => {
      const provider = input.providers[id];
      if (provider === undefined) return [id, value];
      if (!isPlainObject(value)) throw new ProviderRoutingSetChangedError();
      return [id, { ...value, priority: provider.priority, weight: provider.weight }];
    }),
  );
};

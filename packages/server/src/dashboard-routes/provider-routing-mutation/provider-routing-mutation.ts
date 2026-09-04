import { digestProviderEntry } from '@aio-proxy/core';
import type { DashboardProviderRoutingMutation } from '@aio-proxy/types';
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
  if (providerRoutingRevision(current, providerIds) !== input.revision) {
    throw new ProviderRoutingStaleRevisionError();
  }

  const submittedIds = sortedIds(Object.keys(input.providers));
  const expectedIds = sortedIds(providerIds);
  if (submittedIds.length !== expectedIds.length || submittedIds.some((id, index) => id !== expectedIds[index])) {
    throw new ProviderRoutingSetChangedError();
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

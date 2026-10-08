import type { DashboardSettingsMutation } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import type { ServerState } from '../../server-state';

/** Upgrade edited keys to authored identities. Preserving these IDs also makes env-secret
 * rotation independent of the resolved credential and the local database. */
export function withCallerIds(
  current: Record<string, unknown>,
  mutation: DashboardSettingsMutation,
  state: ServerState,
): DashboardSettingsMutation {
  if (mutation.apiKeys === undefined) return mutation;
  const server = current['server'];
  const authored = isPlainObject(server) && Array.isArray(server['apiKeys']) ? server['apiKeys'] : [];
  const runtime = state.currentConfig().server.apiKeys;
  return {
    ...mutation,
    apiKeys: mutation.apiKeys.map((entry) => {
      if (entry.id !== undefined) return entry;
      const index = authored.findIndex((old: unknown) => isPlainObject(old) && old['key'] === entry.key);
      const previous = runtime[index];
      const id = previous === undefined ? crypto.randomUUID() : state.traceStore.resolveUsageCaller(previous).id;
      return { ...entry, id };
    }),
  };
}

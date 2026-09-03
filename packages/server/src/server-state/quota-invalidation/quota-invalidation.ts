import { ProviderKind } from '@aio-proxy/types';

import type { OAuthQuotaCache } from '../../plugin-quota';
import type { Snapshot } from '../snapshot';

export type QuotaIdentityTracker = {
  /** Invalidates every Provider whose quota identity differs from the last commit. */
  readonly reconcile: (snapshot: QuotaIdentitySource) => void;
};

/** The parts of a {@link Snapshot} the tracker reads. */
export type QuotaIdentitySource = Pick<Snapshot, 'config' | 'runtimeCache'>;

/**
 * Everything in the quota cache is keyed by Provider ID alone, so a cached snapshot is only valid
 * while everything the read depends on is unchanged — which is far more than the Provider's own
 * config entry. The runtime identity already digests all of it: plugin package and version, the
 * plugin options digest (which folds in the stored plugin secret), the account options digest, the
 * account's `runtimeRevision` (bumped by every credential write, so a reauthentication moves it),
 * the effective proxy, and the request transforms.
 *
 * Reading it off the committed snapshot rather than re-deriving it also keeps the repository's
 * single-read isolation intact: a corrupt account or unreadable plugin secret is already handled
 * once, during materialization, and marks only its own Provider unavailable.
 *
 * A Provider with no cache entry produced no runtime — it is unavailable, or disabled and
 * reconfigured — and there is then no digest to compare, so the identity cannot be shown unchanged.
 * `null` records that, and the reconcile treats it as changed rather than as "same as last time".
 */
function quotaIdentity({ config, runtimeCache }: QuotaIdentitySource): Map<string, string | null> {
  const identities = new Map<string, string | null>();
  for (const provider of config.providers) {
    if (provider.kind !== ProviderKind.OAuth) continue;
    identities.set(provider.id, runtimeCache.get(provider.id)?.identity ?? null);
  }
  return identities;
}

/**
 * A Provider that appeared, vanished, stopped being an OAuth Provider, or has no digest on either
 * side cannot be shown unchanged. Provider IDs are reusable and the cache also latches a
 * "quota unsupported" mark, so the safe answer is to invalidate: the entry is at worst a failure
 * the Provider would retry anyway.
 */
function unchanged(previous: Map<string, string | null>, next: Map<string, string | null>, id: string): boolean {
  const before = previous.get(id);
  const after = next.get(id);
  return typeof before === 'string' && before === after;
}

/**
 * `initial` seeds the baseline from the snapshot that is already live, so the first commit only
 * invalidates what it actually changed rather than every OAuth Provider in the config.
 */
export function createQuotaIdentityTracker(
  cache: OAuthQuotaCache | undefined,
  initial: QuotaIdentitySource,
): QuotaIdentityTracker {
  let previous = quotaIdentity(initial);
  return {
    reconcile: (snapshot) => {
      const next = quotaIdentity(snapshot);
      if (cache === undefined) {
        previous = next;
        return;
      }
      for (const id of new Set([...previous.keys(), ...next.keys()])) {
        if (!unchanged(previous, next, id)) cache.invalidate(id);
      }
      previous = next;
    },
  };
}

import { isEqual } from 'es-toolkit/predicate';

import type { OAuthQuotaCache } from '../../plugin-quota';

/**
 * Everything in the quota cache is keyed by Provider ID alone, and a Provider ID is reusable. A
 * Provider whose config changed — or that vanished entirely — may point at a different account,
 * plugin, or capability, so its cached snapshot, cooldown, and "unsupported" mark all describe
 * something that no longer exists.
 */
export function invalidateReconfiguredQuota(
  cache: OAuthQuotaCache | undefined,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  if (cache === undefined) return;
  for (const id of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!isEqual(previous[id], next[id])) cache.invalidate(id);
  }
}

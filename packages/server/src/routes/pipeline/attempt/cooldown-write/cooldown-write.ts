import type { RouterResolution } from '@aio-proxy/core';
import { retryAfterMilliseconds } from '@aio-proxy/plugin-sdk';

import type { RuntimeProviderInstance } from '../../../../runtime';
import type { ProviderCooldownStore } from '../../provider-cooldown';

type Candidate = RouterResolution<RuntimeProviderInstance>;

// TTL (ms) to cool a (provider, model) after a failed attempt, or 0 when the
// failure should not cool. Only a 429 with a parseable, positive Retry-After
// cools; the window is clamped to retryAfterCapMs.
export function cooldownTtlMs(
  status: number,
  retryAfterHeader: string | null,
  retryAfterCapMs: number,
  now = Date.now(),
): number {
  if (status !== 429) return 0;
  const parsed = retryAfterMilliseconds(retryAfterHeader, now);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.round(parsed), retryAfterCapMs);
}

export type CooldownSelection =
  | { readonly kind: 'proceed'; readonly live: readonly Candidate[] }
  | { readonly kind: 'all-cooled'; readonly retryAfterSeconds: number };

// Partitions weight/affinity-ordered candidates by cooldown: the live subset to
// try, or an all-cooled synthesis window when every candidate is still cooling.
// Remaining TTL is read ONCE per candidate so filtering and the synthesized
// Retry-After share one reading (a cooldown expiring between two reads must not
// yield a synthetic 1s 429 while a candidate is already live).
//
// Filtering preserves order, so a cooled candidate is skipped even when affinity
// or response-owner ordering put it first. This intentionally overrides the
// session-affinity precedence documented in AGENTS.md ("For each candidate"
// ordering): a cooling provider must not be retried just because a session is
// sticky to it.
export function selectLiveCandidates(
  cooldown: ProviderCooldownStore,
  ordered: readonly Candidate[],
): CooldownSelection {
  const remaining = ordered.map((candidate) => ({
    candidate,
    remainingMs: cooldown.remainingMs(candidate.provider.id, candidate.modelId),
  }));
  const live = remaining.filter((entry) => entry.remainingMs === 0).map((entry) => entry.candidate);
  if (live.length > 0 || ordered.length === 0) return { kind: 'proceed', live };
  const minRemaining = Math.min(...remaining.map((entry) => entry.remainingMs));
  return { kind: 'all-cooled', retryAfterSeconds: Math.max(1, Math.ceil(minRemaining / 1_000)) };
}

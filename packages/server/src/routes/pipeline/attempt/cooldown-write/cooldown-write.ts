import type { RouterCandidate } from '@aio-proxy/core';
import { retryAfterMilliseconds } from '@aio-proxy/plugin-sdk';

import type { RuntimeProviderInstance } from '../../../../runtime';
import type { CandidateHold } from '../../quota-gate';

type Candidate = RouterCandidate<RuntimeProviderInstance>;

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

export type SkippedCandidate = { readonly providerId: string; readonly reason: CandidateHold['reason'] };

export type CooldownSelection =
  | { readonly kind: 'proceed'; readonly live: readonly Candidate[]; readonly skipped: readonly SkippedCandidate[] }
  | {
      readonly kind: 'all-cooled';
      readonly retryAfterSeconds: number;
      readonly skipped: readonly SkippedCandidate[];
    };

// Partitions weight/affinity-ordered candidates by hold (cooldown or known-exhausted
// quota): the live subset to try, or an all-cooled synthesis window when every
// candidate is still held. `holdOf` runs ONCE per candidate so filtering and the
// synthesized Retry-After share one reading (a cooldown expiring between two reads
// must not yield a synthetic 1s 429 while a candidate is already live).
//
// Filtering preserves order, so a held candidate is skipped even when affinity
// or response-owner ordering put it first. This intentionally overrides the
// session-affinity precedence documented in AGENTS.md ("For each candidate"
// ordering): a cooling or exhausted provider must not be retried just because a
// session is sticky to it. The quota window is not capped like a cooldown write:
// it is the upstream's own reset time.
export function selectLiveCandidates(
  ordered: readonly Candidate[],
  holdOf: (candidate: Candidate) => CandidateHold | undefined,
): CooldownSelection {
  const held = ordered.map((candidate) => ({ candidate, hold: holdOf(candidate) }));
  const live = held.filter((entry) => entry.hold === undefined).map((entry) => entry.candidate);
  const skipped = held.flatMap(({ candidate, hold }) =>
    hold === undefined ? [] : [{ providerId: candidate.provider.id, reason: hold.reason }],
  );
  if (live.length > 0 || ordered.length === 0) return { kind: 'proceed', live, skipped };
  const minRemaining = Math.min(...held.map((entry) => entry.hold?.remainingMs ?? 0));
  return { kind: 'all-cooled', retryAfterSeconds: Math.max(1, Math.ceil(minRemaining / 1_000)), skipped };
}

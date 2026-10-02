import type { RouterCandidate } from '@aio-proxy/core';
import type { OAuthQuotaItemScope } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';
import { escapeRegExp } from 'es-toolkit/string';

import type { OAuthQuotaCacheStatus } from '../../../plugin-quota';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';

/** Why selection removed a candidate before attempting it, and for how much longer. */
export type CandidateHold = { readonly reason: 'cooldown' | 'quota_exhausted'; readonly remainingMs: number };

/**
 * How long a sampled snapshot may steer routing. Two of the cache's 5-minute read cooldowns, so one
 * missed refresh is tolerated; past that the snapshot no longer says enough about an account that may
 * have been reset or upgraded since, and the candidate is attempted as if its quota were unknown.
 */
export const QUOTA_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;

function patternMatches(pattern: string, modelId: string): boolean {
  return new RegExp(`^${escapeRegExp(pattern).replaceAll('\\*', '.*')}$`, 'iu').test(modelId);
}

export function quotaScopeCovers(scope: OAuthQuotaItemScope, modelId: string): boolean {
  if (scope === 'account') return true;
  const included = scope.models.some((pattern) => !pattern.startsWith('!') && patternMatches(pattern, modelId));
  return (
    included && !scope.models.some((pattern) => pattern.startsWith('!') && patternMatches(pattern.slice(1), modelId))
  );
}

/**
 * When the cached snapshot proves `modelId` is refused upstream, the time it stops being refused;
 * otherwise `undefined`. Reads only what the cache already holds, so it never waits on upstream, and
 * every doubt (unread, failed, stale, aged, unscoped, unknown ratio or reset) resolves to attempting.
 * The latest reset wins: a model covered by two exhausted windows is refused until both reopen.
 */
export function quotaHeldUntil(status: OAuthQuotaCacheStatus, modelId: string, now: number): number | undefined {
  if (status.kind !== 'ready') return undefined;
  const { snapshot, sampledAt, stale } = status.entry;
  if (stale || now - sampledAt > QUOTA_SNAPSHOT_MAX_AGE_MS) return undefined;
  let heldUntil: number | undefined;
  for (const { scope, remainingRatio, resetsAt } of snapshot.items) {
    if (scope === undefined || remainingRatio === undefined || remainingRatio > 0) continue;
    if (resetsAt === undefined || resetsAt <= now || !quotaScopeCovers(scope, modelId)) continue;
    heldUntil = Math.max(heldUntil ?? 0, resetsAt);
  }
  return heldUntil;
}

/**
 * Whether `candidate` must sit this request out: a live cooldown, a cached snapshot proving its
 * subscription is refused for this model, or both — in which case the longer wait wins, since the
 * candidate is unusable until both clear.
 *
 * A held subscription is warmed so an early reset (a redeemed credit, an upgraded plan) is noticed
 * while it is skipped. Only held candidates are: a candidate about to serve is warmed after its body
 * settles, and a read started here would pre-empt that one with the pre-request balance.
 */
export function candidateHold(
  source: Pick<ProviderRouteSource, 'cooldown' | 'quotaStatus' | 'warmProviderQuota'>,
  candidate: RouterCandidate<RuntimeProviderInstance>,
  now: number,
): CandidateHold | undefined {
  const { provider, modelId } = candidate;
  const cooldownMs = source.cooldown.remainingMs(provider.id, modelId);
  const heldUntil =
    provider.kind === ProviderKind.OAuth && source.quotaStatus !== undefined
      ? quotaHeldUntil(source.quotaStatus(provider.id), modelId, now)
      : undefined;
  if (heldUntil !== undefined) source.warmProviderQuota?.(provider.id);
  const quotaMs = heldUntil === undefined ? 0 : heldUntil - now;
  if (quotaMs > cooldownMs) return { reason: 'quota_exhausted', remainingMs: quotaMs };
  return cooldownMs > 0 ? { reason: 'cooldown', remainingMs: cooldownMs } : undefined;
}

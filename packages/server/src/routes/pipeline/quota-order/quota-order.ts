import type { RouterCandidate } from '@aio-proxy/core';
import { type RouterConfig, ProviderKind } from '@aio-proxy/types';

import type { OAuthQuotaCacheStatus } from '../../../plugin-quota';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';
import { freshQuotaSnapshot, quotaScopeCovers } from '../quota-gate';

type Candidate = RouterCandidate<RuntimeProviderInstance>;

/**
 * When this candidate's quota allowance for `modelId` expires, or `undefined` when that is unknown.
 * The allowance at stake is the longest window covering the model — a weekly window, not the 5-hour
 * one — so its reset is the key, not simply the latest reset: a weekly window can reset before a
 * 5-hour window that started after it. No covering windows, or any covering window with a missing
 * or elapsed reset, makes the allowance unknown. A single covering window decides without a length;
 * with multiple covering windows, any missing length makes the allowance unknown. Otherwise,
 * use the longest window's reset.
 */
function allowanceResetsAt(candidate: Candidate, status: OAuthQuotaCacheStatus, now: number): number | undefined {
  if (candidate.provider.kind !== ProviderKind.OAuth) return undefined;
  const snapshot = freshQuotaSnapshot(status, now);
  if (snapshot === undefined) return undefined;
  const covering = snapshot.items.filter(
    (item) => item.scope !== undefined && quotaScopeCovers(item.scope, candidate.modelId),
  );
  if (covering.length === 0) return undefined;
  if (covering.some((item) => item.resetsAt === undefined || item.resetsAt <= now)) return undefined;
  if (covering.length === 1) return covering[0]?.resetsAt;
  let longest: (typeof covering)[number] | undefined;
  for (const item of covering) {
    if (item.windowMinutes === undefined) return undefined;
    if (item.windowMinutes > (longest?.windowMinutes ?? 0)) longest = item;
  }
  return longest?.resetsAt;
}

function orderTier(
  tier: readonly Candidate[],
  quotaStatus: (providerId: string) => OAuthQuotaCacheStatus,
  now: number,
  warm?: (providerId: string) => void,
  options?: { readonly warmLeader?: boolean },
) {
  if (tier.length < 2) return tier;
  const keyed: { readonly candidate: Candidate; readonly resetsAt: number }[] = [];
  const unknown: Candidate[] = [];
  for (const candidate of tier) {
    const resetsAt = allowanceResetsAt(candidate, quotaStatus(candidate.provider.id), now);
    if (resetsAt === undefined) unknown.push(candidate);
    else keyed.push({ candidate, resetsAt });
  }
  // `sort` is stable, so equal resets keep the router's (weighted or deterministic) order.
  keyed.sort((left, right) => left.resetsAt - right.resetsAt);
  const ordered = [
    ...keyed.map(({ candidate }) => ({ ...candidate, selectionSource: 'quota_reset' as const })),
    ...unknown,
  ];
  for (const candidate of unknown) {
    if ((options?.warmLeader === true || candidate !== ordered[0]) && candidate.provider.kind === ProviderKind.OAuth) {
      warm?.(candidate.provider.id);
    }
  }
  return ordered;
}

/**
 * Within each Provider priority tier, the subscription whose allowance expires soonest goes first, so
 * allowance is not left to lapse on one subscription while another is drained. Candidates with no
 * usable quota follow in the router's order. Tiers never mix, and a provider-qualified route is left
 * alone: its `selectionSource` is what strips the Provider ID back to the public slug.
 * Unknown OAuth candidates behind the first in each tier are warmed without waiting. By default,
 * the serving subscription warms after success; `warmLeader` also warms it for calls that spend no quota.
 */
export function orderByQuotaReset(
  candidates: readonly Candidate[],
  quotaStatus: (providerId: string) => OAuthQuotaCacheStatus,
  now: number,
  warm?: (providerId: string) => void,
  options?: { readonly warmLeader?: boolean },
): readonly Candidate[] {
  if (candidates.some((candidate) => candidate.selectionSource === 'provider_qualified')) return candidates;
  const ordered: Candidate[] = [];
  let start = 0;
  for (let index = 1; index <= candidates.length; index += 1) {
    if (index < candidates.length && candidates[index]?.routing.priority === candidates[start]?.routing.priority) {
      continue;
    }
    ordered.push(...orderTier(candidates.slice(start, index), quotaStatus, now, warm, options));
    start = index;
  }
  return ordered;
}

/** The opt-in `router.selection` policy; the weighted draw returns the router's candidates untouched. */
export function applySelectionPolicy(
  candidates: readonly Candidate[],
  selection: RouterConfig['selection'] | undefined,
  source: Pick<ProviderRouteSource, 'quotaStatus' | 'warmProviderQuota'>,
  now: number,
  options?: { readonly warmLeader?: boolean },
): readonly Candidate[] {
  if (selection !== 'quota-reset' || source.quotaStatus === undefined) return candidates;
  return orderByQuotaReset(candidates, source.quotaStatus, now, source.warmProviderQuota, options);
}

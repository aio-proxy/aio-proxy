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
 * 5-hour window that started after it. Several covering windows that report no length leave the
 * allowance ambiguous, which is unknown.
 */
function allowanceResetsAt(candidate: Candidate, status: OAuthQuotaCacheStatus, now: number): number | undefined {
  if (candidate.provider.kind !== ProviderKind.OAuth) return undefined;
  const snapshot = freshQuotaSnapshot(status, now);
  if (snapshot === undefined) return undefined;
  const covering = snapshot.items.filter(
    (item) =>
      item.scope !== undefined &&
      item.resetsAt !== undefined &&
      item.resetsAt > now &&
      quotaScopeCovers(item.scope, candidate.modelId),
  );
  if (covering.length === 1) return covering[0]?.resetsAt;
  let longest: (typeof covering)[number] | undefined;
  for (const item of covering) {
    if (item.windowMinutes !== undefined && item.windowMinutes > (longest?.windowMinutes ?? 0)) longest = item;
  }
  return longest?.resetsAt;
}

function orderTier(
  tier: readonly Candidate[],
  quotaStatus: (providerId: string) => OAuthQuotaCacheStatus,
  now: number,
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
  return [...keyed.map(({ candidate }) => ({ ...candidate, selectionSource: 'quota_reset' as const })), ...unknown];
}

/**
 * Within each Provider priority tier, the subscription whose allowance expires soonest goes first, so
 * allowance is not left to lapse on one subscription while another is drained. Candidates with no
 * usable quota follow in the router's order. Tiers never mix, and a provider-qualified route is left
 * alone: its `selectionSource` is what strips the Provider ID back to the public slug.
 */
export function orderByQuotaReset(
  candidates: readonly Candidate[],
  quotaStatus: (providerId: string) => OAuthQuotaCacheStatus,
  now: number,
): readonly Candidate[] {
  if (candidates.some((candidate) => candidate.selectionSource === 'provider_qualified')) return candidates;
  const ordered: Candidate[] = [];
  let start = 0;
  for (let index = 1; index <= candidates.length; index += 1) {
    if (index < candidates.length && candidates[index]?.routing.priority === candidates[start]?.routing.priority) {
      continue;
    }
    ordered.push(...orderTier(candidates.slice(start, index), quotaStatus, now));
    start = index;
  }
  return ordered;
}

/** The opt-in `router.selection` policy; the weighted draw returns the router's candidates untouched. */
export function applySelectionPolicy(
  candidates: readonly Candidate[],
  selection: RouterConfig['selection'] | undefined,
  source: Pick<ProviderRouteSource, 'quotaStatus'>,
  now: number,
): readonly Candidate[] {
  if (selection !== 'quota-reset' || source.quotaStatus === undefined) return candidates;
  return orderByQuotaReset(candidates, source.quotaStatus, now);
}

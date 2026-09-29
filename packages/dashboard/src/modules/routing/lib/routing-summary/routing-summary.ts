import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider, RouterProviderOverride } from '@aio-proxy/types';
import { RoutingPrioritySchema, RoutingWeightSchema } from '@aio-proxy/types';

export type RoutingTierCandidate = {
  readonly providerId: string;
  readonly priority: number;
  readonly weight: number;
  readonly eligible: boolean;
};

export type RoutingTier = {
  readonly priority: number;
  readonly providers: readonly { readonly providerId: string; readonly weight: number; readonly share: number }[];
};

export type RoutingProviderDraft = {
  readonly priority?: number;
  readonly weight?: number;
};

const optionalParsed = (kind: 'priority' | 'weight', value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const parsed = (kind === 'priority' ? RoutingPrioritySchema : RoutingWeightSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const buildRoutingTiers = (candidates: readonly RoutingTierCandidate[]): readonly RoutingTier[] => {
  const totals = new Map<number, number>();
  for (const candidate of candidates) {
    if (!candidate.eligible) continue;
    totals.set(candidate.priority, (totals.get(candidate.priority) ?? 0) + candidate.weight);
  }
  const priorities = [...totals.keys()].sort((left, right) => right - left);
  return priorities.map((priority) => ({
    priority,
    providers: candidates
      .filter((candidate) => candidate.eligible && candidate.priority === priority)
      .map((candidate) => {
        const total = totals.get(priority) ?? 0;
        return {
          providerId: candidate.providerId,
          weight: candidate.weight,
          share: total === 0 ? 0 : candidate.weight / total,
        };
      }),
  }));
};

export const effectiveRoutingCandidates = (
  providers: readonly DashboardRoutingProvider[],
  draft: Readonly<Record<string, RoutingProviderDraft>>,
): RoutingTierCandidate[] =>
  providers.map((provider) => {
    const override = draft[provider.id] ?? {};
    const priority = optionalParsed('priority', override.priority) ?? provider.defaults.priority.effective;
    const weight = optionalParsed('weight', override.weight) ?? provider.defaults.weight.effective;
    return {
      providerId: provider.id,
      priority,
      weight,
      eligible: provider.enabled && provider.state.status === 'ready' && weight > 0,
    };
  });

export const formatRoutingTiers = (tiers: readonly RoutingTier[]): string =>
  tiers
    .map((tier, index) => {
      const members = tier.providers
        .map((entry) =>
          tier.providers.length === 1 ? entry.providerId : `${entry.providerId} ${Math.round(entry.share * 100)}%`,
        )
        .join(' / ');
      return `${m['dashboard.routing.tier_label.tier']({ value: index + 1 })}: ${members}`;
    })
    .join(' → ');

export const formatRoutingShareValue = (share: number): number | string => {
  if (share === 0) return 0;
  const hundredths = Math.round(share * 10_000) / 100;
  if (hundredths > 0) return Number.isInteger(hundredths) ? hundredths : hundredths.toFixed(2);
  return (Math.round(share * 1_000_000) / 10_000).toFixed(4);
};

export const formatRoutingShare = (share: number): string => `${formatRoutingShareValue(share)}%`;

const TIER_SHARE_FLOOR = 0.01;

/**
 * Whole-percent labels for one tier's configured shares. Rounding each share on its own lets a
 * three-way even split read 33/33/33, so the percents are handed out by largest remainder and
 * always sum to 100. A candidate under 1% reads `<1%` instead of `0%`: weight-zero Providers never
 * reach a tier, so a `0%` would claim a candidate is idle when it is only small.
 */
export const formatTierShares = (shares: readonly number[]): readonly string[] => {
  const percents = shares.map((share) => share * 100);
  const floors = percents.map(Math.floor);
  let remaining = 100 - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = percents
    .map((percent, index) => ({ index, remainder: percent - (floors[index] ?? 0) }))
    .filter(({ index }) => (shares[index] ?? 0) >= TIER_SHARE_FLOOR)
    .sort((left, right) => right.remainder - left.remainder);
  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    remaining -= 1;
  }
  return shares.map((share, index) => (share < TIER_SHARE_FLOOR ? '<1%' : `${floors[index] ?? 0}%`));
};

export const routingDraftNormalization = (
  kind: 'priority' | 'weight',
  authored: number | undefined,
): { readonly authored: number; readonly effective: number } | undefined => {
  if (authored === undefined || !Number.isFinite(authored)) return undefined;
  const parsed = (kind === 'priority' ? RoutingPrioritySchema : RoutingWeightSchema).safeParse(authored);
  if (!parsed.success || parsed.data === authored) return undefined;
  return { authored, effective: parsed.data };
};

export const explicitRoutingOverrides = (
  draft: Readonly<Record<string, RoutingProviderDraft>>,
): Readonly<Record<string, RouterProviderOverride>> =>
  Object.fromEntries(
    Object.entries(draft).flatMap(([providerId, value]) => {
      const priority = optionalParsed('priority', value.priority);
      const weight = optionalParsed('weight', value.weight);
      if (priority === undefined && weight === undefined) return [];
      return [
        [
          providerId,
          {
            ...(priority === undefined ? {} : { priority }),
            ...(weight === undefined ? {} : { weight }),
          },
        ],
      ];
    }),
  );

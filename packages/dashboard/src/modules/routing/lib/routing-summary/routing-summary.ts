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
    .map((tier) => {
      const members = tier.providers
        .map((entry) =>
          tier.providers.length === 1 ? entry.providerId : `${entry.providerId} ${Math.round(entry.share * 100)}%`,
        )
        .join(' / ');
      return `${m['dashboard.routing.editor.tier']({ value: tier.priority })}: ${members}`;
    })
    .join(' → ');

export const formatRoutingShare = (share: number): string => `${Math.round(share * 100)}%`;

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

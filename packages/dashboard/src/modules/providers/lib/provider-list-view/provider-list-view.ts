import type { DashboardProviderSummary } from '@aio-proxy/types';

export type ProviderAvailabilityFilter = 'all' | 'available' | 'unavailable';
export type ProviderEnablementFilter = 'all' | 'enabled' | 'disabled';
export type ProviderKindFilter = 'all' | 'oauth' | 'api' | 'ai-sdk';

export interface ProviderListFilters {
  readonly search: string;
  readonly availability: ProviderAvailabilityFilter;
  readonly enablement: ProviderEnablementFilter;
  readonly kind: ProviderKindFilter;
}

export const emptyProviderListFilters: ProviderListFilters = {
  search: '',
  availability: 'all',
  enablement: 'all',
  kind: 'all',
};

// A Provider the editor cannot represent must not offer an edit affordance at all.
const uneditableDiagnosticCodes = new Set(['PROVIDER_CONFIG_INVALID', 'LEGACY_OAUTH_CONFIG_UNSUPPORTED']);

export const canEditProvider = (provider: DashboardProviderSummary): boolean =>
  provider.kind !== 'invalid' &&
  (provider.state.diagnostic === undefined || !uneditableDiagnosticCodes.has(provider.state.diagnostic.code));

/**
 * The configured name wins; an OAuth account that was never named falls back to its account label
 * (an email in practice). The Provider ID is the last resort and is otherwise only a hover title.
 */
export const providerDisplayName = (provider: DashboardProviderSummary): string =>
  provider.name ?? provider.accountLabel ?? provider.id;

// Absent values coalesce to the schema defaults so a card without explicit routing sorts predictably.
const effectivePriority = (provider: DashboardProviderSummary): number => provider.priority ?? 0;
const effectiveWeight = (provider: DashboardProviderSummary): number => provider.weight ?? 1;

const matchesSearch = (provider: DashboardProviderSummary, search: string): boolean => {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return providerDisplayName(provider).toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle);
};

const matchesAvailability = (provider: DashboardProviderSummary, filter: ProviderAvailabilityFilter): boolean =>
  filter === 'all' || (filter === 'unavailable') === (provider.state.status === 'unavailable');

const matchesEnablement = (provider: DashboardProviderSummary, filter: ProviderEnablementFilter): boolean =>
  filter === 'all' || (filter === 'enabled') === provider.enabled;

const matchesKind = (provider: DashboardProviderSummary, filter: ProviderKindFilter): boolean =>
  filter === 'all' || provider.kind === filter;

export const visibleProviders = (
  providers: readonly DashboardProviderSummary[],
  filters: ProviderListFilters,
): readonly DashboardProviderSummary[] =>
  providers
    .filter(
      (provider) =>
        matchesSearch(provider, filters.search) &&
        matchesAvailability(provider, filters.availability) &&
        matchesEnablement(provider, filters.enablement) &&
        matchesKind(provider, filters.kind),
    )
    .toSorted(
      (left, right) =>
        effectivePriority(right) - effectivePriority(left) ||
        effectiveWeight(right) - effectiveWeight(left) ||
        left.id.localeCompare(right.id),
    );

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

// These codes are the config parser's own verdict on an entry it refused, so they mark exactly the
// Providers that exist as a diagnostic instead of a configuration. `kind` alone is not enough: a
// rejected entry keeps whatever kind was recognizable, so a broken `api` entry still reports 'api'.
const invalidConfigDiagnosticCodes = new Set(['PROVIDER_CONFIG_INVALID', 'LEGACY_OAUTH_CONFIG_UNSUPPORTED']);

/** A Provider missing from the parsed configuration: the editor cannot represent it and routing cannot move it. */
export const isDegradedProvider = (provider: DashboardProviderSummary): boolean =>
  provider.kind === 'invalid' ||
  (provider.state.diagnostic !== undefined && invalidConfigDiagnosticCodes.has(provider.state.diagnostic.code));

export const canEditProvider = (provider: DashboardProviderSummary): boolean => !isDegradedProvider(provider);

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
    // `filter` already produced a fresh array, so sorting in place mutates nothing the caller owns.
    // `toSorted` is not in this package's TypeScript lib target.
    .sort(
      (left, right) =>
        effectivePriority(right) - effectivePriority(left) ||
        effectiveWeight(right) - effectiveWeight(left) ||
        left.id.localeCompare(right.id),
    );

import type { DashboardProviderSummary } from '@aio-proxy/types';

/**
 * The configured name wins; an OAuth account that was never named falls back to its account label
 * (an email in practice). The Provider ID is the last resort and is otherwise only a hover title.
 */
export const providerDisplayName = (provider: DashboardProviderSummary): string =>
  provider.name ?? provider.accountLabel ?? provider.id;

import { type DashboardPluginSummary, type DashboardProviderSummary, ProviderKind } from '@aio-proxy/types';

import { resolveDashboardText } from '@/lib/localized-text';

export const providerKindLabel = (provider: DashboardProviderSummary | undefined): string | undefined => {
  switch (provider?.kind) {
    case ProviderKind.Api:
      return 'API';
    case ProviderKind.AiSdk:
      return 'AI SDK';
    case ProviderKind.OAuth:
      return 'OAuth';
    default:
      return undefined;
  }
};

export const providerOAuthService = (
  provider: DashboardProviderSummary | undefined,
  plugins: readonly DashboardPluginSummary[] | undefined,
): string | undefined => {
  if (provider?.kind !== ProviderKind.OAuth || provider.plugin === undefined) return undefined;
  const plugin = plugins?.find((item) => item.packageName === provider.plugin);
  const service =
    plugin?.displayName === undefined
      ? provider.plugin.slice(provider.plugin.lastIndexOf('/') + 1)
      : resolveDashboardText(plugin.displayName);
  return provider.capability === undefined || provider.capability === 'default'
    ? service
    : `${service} / ${provider.capability}`;
};

import type { DashboardPluginSummary, DashboardProviderSummary } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';

import { ProviderMark } from '@/components/provider-mark';
import { providerDisplayName } from '@/lib/provider-display-name';
import { providerPluginPresentationsQueryOptions } from '@/modules/providers/services/provider-plugin-labels';
import { providersQueryOptions } from '@/modules/providers/services/providers-query';

interface ProviderIdLabelProps {
  readonly providerId: string;
  readonly className?: string;
}

const pluginIconFor = (
  provider: DashboardProviderSummary,
  plugins: readonly DashboardPluginSummary[] | undefined,
): string | undefined =>
  provider.plugin === undefined ? undefined : plugins?.find((plugin) => plugin.packageName === provider.plugin)?.icon;

/**
 * A stored Provider ID rendered the way the providers page renders that Provider:
 * configured name, otherwise the account label, otherwise the ID. The ID itself
 * stays on the hover title. An ID that is no longer in the catalog stays as text.
 */
export const ProviderIdLabel: React.FC<ProviderIdLabelProps> = ({ providerId, className }) => {
  const providers = useQuery(providersQueryOptions());
  const plugins = useQuery(providerPluginPresentationsQueryOptions());
  const provider = providers.data?.providers.find((item) => item.id === providerId);

  if (provider === undefined) {
    return (
      <span className={cn('inline-block min-w-0 truncate', className)} title={providerId}>
        {providerId}
      </span>
    );
  }

  const name = providerDisplayName(provider);
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} title={providerId}>
      <ProviderMark provider={provider} pluginIcon={pluginIconFor(provider, plugins.data?.plugins)} />
      <span className="truncate">{name}</span>
    </span>
  );
};

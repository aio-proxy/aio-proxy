import type { DashboardPluginSummary, DashboardProviderSummary } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';

import { ProviderMark } from '@/components/provider-mark';
import { providerDisplayName } from '@/lib/provider-display-name';

interface ProviderIdLabelProps {
  readonly providerId: string;
  readonly className?: string;
  readonly providers?: readonly DashboardProviderSummary[];
  readonly plugins?: readonly DashboardPluginSummary[];
  readonly mark?: boolean;
}

const pluginIconFor = (
  provider: DashboardProviderSummary,
  plugins: readonly DashboardPluginSummary[] | undefined,
): string | undefined =>
  provider.plugin === undefined ? undefined : plugins?.find((plugin) => plugin.packageName === provider.plugin)?.icon;

/**
 * A stored Provider ID rendered the way the providers page names that Provider:
 * configured name, otherwise the account label, otherwise the ID. The ID itself
 * stays on the hover title. `mark` draws the providers-page icon; trace detail
 * turns it off. Callers pass the catalog; a missing list or an ID that is no
 * longer in it stays as text.
 */
export const ProviderIdLabel: React.FC<ProviderIdLabelProps> = ({
  providerId,
  className,
  providers,
  plugins,
  mark = true,
}) => {
  const provider = providers?.find((item) => item.id === providerId);

  if (provider === undefined) {
    return (
      <span className={cn('inline-block min-w-0 truncate', className)} title={providerId}>
        {providerId}
      </span>
    );
  }

  const name = providerDisplayName(provider);
  return (
    <span className={cn('inline-flex min-w-0 items-center', mark && 'gap-1.5', className)} title={providerId}>
      {mark ? <ProviderMark provider={provider} pluginIcon={pluginIconFor(provider, plugins)} /> : null}
      <span className="truncate">{name}</span>
    </span>
  );
};

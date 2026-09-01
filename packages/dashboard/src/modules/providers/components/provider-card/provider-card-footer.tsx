import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import type React from 'react';

import { formatCompactTokenCount } from '@/components/token-count';

import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderEnabledSwitch } from '../provider-enabled-switch';
import { ProviderMoreMenu } from '../provider-more-menu';

interface ProviderCardFooterProps {
  readonly provider: DashboardProviderSummary;
  readonly usage: ProviderUsage | undefined;
  readonly usagePending: boolean;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

const requestCountLabel = (usage: ProviderUsage | undefined, usagePending: boolean): string => {
  if (usagePending) return '…';
  return usage === undefined ? 'N/A' : formatCompactTokenCount(usage.requestCount);
};

export const ProviderCardFooter: React.FC<ProviderCardFooterProps> = ({ provider, usage, usagePending, onDelete }) => (
  <div className="flex items-center justify-between gap-2">
    <div className="truncate text-xs text-muted-foreground">
      {`${m['dashboard.providers.card.models_count']({ count: provider.clientModels.length })} · ${m['dashboard.providers.card.requests_24h']({ count: requestCountLabel(usage, usagePending) })}`}
    </div>
    {/* Above the identity link's full-card `::after` overlay, so these stay clickable. */}
    <div className="relative z-10 flex shrink-0 items-center gap-1">
      <ProviderEnabledSwitch provider={provider} />
      <ProviderMoreMenu provider={provider} onDelete={onDelete} />
    </div>
  </div>
);

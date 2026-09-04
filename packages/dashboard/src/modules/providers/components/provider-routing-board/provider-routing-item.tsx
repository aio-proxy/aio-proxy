import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import type React from 'react';

import { providerDisplayName } from '../../lib/provider-list-view';

interface ProviderRoutingItemProps {
  readonly provider: DashboardProviderSummary;
}

export const ProviderRoutingItem: React.FC<ProviderRoutingItemProps> = ({ provider }) => {
  const stateLabel =
    provider.state.status === 'unavailable'
      ? m['dashboard.routing.editor.provider_unavailable']()
      : m['dashboard.routing.editor.provider_ready']();

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{providerDisplayName(provider)}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <Badge variant="outline">{stateLabel}</Badge>
        {provider.enabled ? null : (
          <Badge variant="secondary">{m['dashboard.routing.editor.provider_disabled']()}</Badge>
        )}
      </div>
    </div>
  );
};

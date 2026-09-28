import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { WeightField } from '@/components/weight-field';
import { providerDisplayName } from '@/lib/provider-display-name';

import { PROVIDER_ROUTING_ROW_GRID } from '../../lib/provider-routing-board';

interface ProviderRoutingItemProps {
  readonly provider: DashboardProviderSummary;
  readonly weight: number;
  /** The Provider's share of its tier in percent; unused while its weight is zero. */
  readonly share: number;
  readonly onWeightChange: (weight: number) => void;
}

/** One Provider as a row of the default routing: who it is, its weight, and the share that gives it. */
export const ProviderRoutingItem: React.FC<ProviderRoutingItemProps> = ({
  provider,
  weight,
  share,
  onWeightChange,
}) => {
  const parked = weight === 0;
  return (
    <div className={cn(PROVIDER_ROUTING_ROW_GRID, 'text-sm')}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('truncate', !parked && 'font-medium', parked && 'text-muted-foreground')}>
          {providerDisplayName(provider)}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{provider.id}</span>
        {provider.state.status === 'unavailable' ? (
          <Badge variant="outline" className="shrink-0">
            {m['dashboard.routing.editor.provider_unavailable']()}
          </Badge>
        ) : null}
        {provider.enabled ? null : (
          <Badge variant="secondary" className="shrink-0">
            {m['dashboard.routing.editor.provider_disabled']()}
          </Badge>
        )}
      </div>
      <WeightField
        weight={weight}
        // Zero is how a Provider is parked outside normal routing, so the field goes down to it.
        min={0}
        aria-label={m['dashboard.routing.detail.weight_label']({ providerId: provider.id })}
        data-testid={`provider-weight-${provider.id}`}
        onWeightChange={onWeightChange}
      />
      <span
        className={cn('text-right font-mono text-xs tabular-nums', parked && 'text-muted-foreground')}
        data-testid={`provider-share-${provider.id}`}
      >
        {parked ? m['dashboard.providers.routing.parked']() : `${share}%`}
      </span>
    </div>
  );
};

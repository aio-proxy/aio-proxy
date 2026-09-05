import { m } from '@aio-proxy/i18n';
import { Card } from '@aio-proxy/ui/components/card';
import type React from 'react';

export interface ProviderCardRoutingProps {
  readonly tier: number;
  readonly share: number;
  readonly parked: boolean;
}

export const ProviderCardRouting: React.FC<ProviderCardRoutingProps> = ({ tier, share, parked }) => (
  <Card size="sm" className="mx-2 -mt-4 gap-0 bg-muted/80 pt-4 pb-0 shadow-xs" data-testid="provider-card-routing">
    <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{m['dashboard.providers.card.default_route']()}</span>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
        <span className="font-medium whitespace-nowrap" data-testid="provider-card-route-tier">
          {m['dashboard.providers.routing.tier']({ tier })}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <span className="whitespace-nowrap tabular-nums" data-testid="provider-card-route-share">
          {parked
            ? m['dashboard.providers.card.default_parked']()
            : m['dashboard.providers.card.weight_share']({ value: share })}
        </span>
      </div>
    </div>
  </Card>
);

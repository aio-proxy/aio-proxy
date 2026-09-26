import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { formatRoutingShare } from '../../lib/routing-summary';
import type { RoutingTierShare } from '../../lib/routing-traffic';

interface RoutingShareBarProps {
  readonly tiers: DashboardRoutingModel['tiers'];
  readonly actual: readonly RoutingTierShare[] | undefined;
}

const segmentLabel = (providerId: string, kind: 'configured' | 'actual', share: number): string => {
  const role =
    kind === 'configured' ? m['dashboard.routing.share.configured']() : m['dashboard.routing.share.actual']();
  return `${providerId}, ${role}, ${formatRoutingShare(share)}`;
};

export const RoutingShareBar: React.FC<RoutingShareBarProps> = ({ tiers, actual }) => {
  if (tiers.length === 0) {
    return <Badge variant="outline">{m['dashboard.routing.table.disabled']()}</Badge>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {tiers.map((tier) => {
        const tierActual = actual?.filter((entry) =>
          tier.providers.some((provider) => provider.providerId === entry.providerId),
        );
        return (
          <div key={tier.priority} className="flex flex-col gap-1">
            <div className="flex h-3 w-full overflow-hidden rounded-sm bg-muted">
              {tier.providers.map((provider, index) => {
                const label = segmentLabel(provider.providerId, 'configured', provider.share);
                return (
                  <Tooltip key={provider.providerId}>
                    <TooltipTrigger
                      render={
                        <div
                          className={cn('h-full shrink-0 bg-primary', index > 0 && 'border-l border-background')}
                          style={{ width: `${provider.share * 100}%` }}
                          aria-label={label}
                          role="img"
                          tabIndex={0}
                        />
                      }
                    />
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
            {tierActual === undefined ? null : (
              <div data-testid="routing-share-actual" className="flex h-1 w-full overflow-hidden rounded-sm bg-muted">
                {tierActual.map((entry, index) => {
                  const label = segmentLabel(entry.providerId, 'actual', entry.actualShare);
                  return (
                    <Tooltip key={entry.providerId}>
                      <TooltipTrigger
                        render={
                          <div
                            className={cn('h-full shrink-0 bg-primary/70', index > 0 && 'border-l border-background')}
                            style={{ width: `${entry.actualShare * 100}%` }}
                            aria-label={label}
                            role="img"
                            tabIndex={0}
                          />
                        }
                      />
                      <TooltipContent>{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

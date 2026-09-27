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

/** A Provider keeps one colour in both rows of its tier, which is what makes the rows comparable:
 * widths alone cannot be matched up once a Provider serves nothing and its segment collapses. */
const segmentColor = (index: number) => `var(--chart-${(index % 5) + 1})`;

/** Trimmed to four decimals so a share like `0.07` does not reach the DOM as `7.000000000000001%`.
 * Far finer than a pixel at any table width, so the segments still sum to the full bar. */
const segmentWidth = (share: number) => `${Number((share * 100).toFixed(4))}%`;

export const RoutingShareBar: React.FC<RoutingShareBarProps> = ({ tiers, actual }) => {
  if (tiers.length === 0) {
    return <Badge variant="outline">{m['dashboard.routing.table.disabled']()}</Badge>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {tiers.map((tier) => {
        // Both rows walk `tier.providers`, so segment N is the same Provider in each. Reading the
        // measured shares off their own array instead would drop the Providers that served nothing
        // and shift every remaining segment left, under a neighbour's configured share.
        const measured =
          actual === undefined
            ? undefined
            : tier.providers.map(
                (provider) => actual.find((entry) => entry.providerId === provider.providerId)?.actualShare ?? 0,
              );

        return (
          <div key={tier.priority} className="flex flex-col gap-1">
            <span className="text-[0.625rem] leading-none text-muted-foreground">
              {m['dashboard.routing.share.tier']({ value: tier.priority })}
            </span>
            <div className="flex h-3 w-full overflow-hidden rounded-sm bg-muted">
              {tier.providers.map((provider, index) => {
                const label = segmentLabel(provider.providerId, 'configured', provider.share);
                return (
                  <Tooltip key={provider.providerId}>
                    <TooltipTrigger
                      render={
                        <div
                          className={cn('h-full shrink-0', index > 0 && 'border-l border-background')}
                          style={{ width: segmentWidth(provider.share), backgroundColor: segmentColor(index) }}
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
            {measured === undefined ? null : (
              <div data-testid="routing-share-actual" className="flex h-1 w-full overflow-hidden rounded-sm bg-muted">
                {tier.providers.map((provider, index) => {
                  const share = measured[index] ?? 0;
                  const label = segmentLabel(provider.providerId, 'actual', share);
                  return (
                    <Tooltip key={provider.providerId}>
                      <TooltipTrigger
                        render={
                          <div
                            className={cn('h-full shrink-0', index > 0 && 'border-l border-background')}
                            style={{ width: segmentWidth(share), backgroundColor: segmentColor(index) }}
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

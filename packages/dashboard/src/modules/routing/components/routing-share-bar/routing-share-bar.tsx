import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import type React from 'react';

import { ProviderLabel } from '@/components/provider-label';
import { RoutingTierLabel } from '@/components/routing-tier-label';

import { formatRoutingShare } from '../../lib/routing-summary';
import type { RoutingTierShare } from '../../lib/routing-traffic';

interface RoutingShareBarProps {
  readonly tiers: DashboardRoutingModel['tiers'];
  readonly actual: readonly RoutingTierShare[] | undefined;
}

const shareText = (share: number) => formatRoutingShare(share);
const visibleProviderLimit = 3;

export const RoutingShareBar: React.FC<RoutingShareBarProps> = ({ tiers, actual }) => {
  if (tiers.length === 0) {
    return <span className="text-sm text-muted-foreground">{m['dashboard.routing.table.disabled']()}</span>;
  }

  return (
    <div className="relative flex min-w-0 flex-col gap-3 before:absolute before:inset-y-3 before:left-2 before:w-px before:bg-border">
      {tiers.map((tier, tierIndex) => {
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
          <div key={tier.priority} className="relative grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5">
            <span className="z-[1] mt-0.5 flex size-5 items-center justify-center rounded-full border border-muted-foreground bg-background font-mono text-sm leading-none text-muted-foreground">
              {tierIndex + 1}
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <RoutingTierLabel
                  tier={tierIndex + 1}
                  priority={tier.priority}
                  className="truncate text-sm leading-5 font-medium text-foreground"
                />
              </div>
              <div
                className="flex min-w-0 flex-nowrap items-baseline gap-x-4 overflow-hidden text-sm text-ellipsis whitespace-nowrap"
                title={tier.providers
                  .map((provider) => `${provider.providerId} ${shareText(provider.share)}`)
                  .join(' · ')}
              >
                {tier.providers.slice(0, visibleProviderLimit).map((provider) => (
                  <ProviderLabel key={provider.providerId} providerId={provider.providerId}>
                    {({ name, providerId }) => (
                      <span className="inline-flex min-w-0 items-baseline gap-2" title={providerId}>
                        <span className="truncate">{name}</span>
                        <span className="shrink-0 font-mono text-sm text-muted-foreground tabular-nums">
                          {shareText(provider.share)}
                        </span>
                      </span>
                    )}
                  </ProviderLabel>
                ))}
                {tier.providers.length > visibleProviderLimit ? (
                  <span className="shrink-0 text-sm text-muted-foreground">
                    +{tier.providers.length - visibleProviderLimit}
                  </span>
                ) : null}
              </div>
              {measured === undefined ? null : (
                <div
                  data-testid="routing-share-actual"
                  className="flex min-w-0 flex-nowrap items-baseline gap-x-3 overflow-hidden text-sm text-ellipsis whitespace-nowrap text-muted-foreground"
                  title={tier.providers
                    .map((provider, index) => `${provider.providerId} ${shareText(measured[index] ?? 0)}`)
                    .join(' · ')}
                >
                  <span className="shrink-0">{m['dashboard.routing.share.actual']()}</span>
                  {tier.providers.slice(0, visibleProviderLimit).map((provider, index) => {
                    const share = measured[index] ?? 0;
                    return (
                      <ProviderLabel key={provider.providerId} providerId={provider.providerId}>
                        {({ name, providerId }) => (
                          <span className="inline-flex min-w-0 items-baseline gap-2" title={providerId}>
                            <span className="truncate">{name}</span>
                            <span className="shrink-0 font-mono text-sm text-foreground tabular-nums">
                              {shareText(share)}
                            </span>
                          </span>
                        )}
                      </ProviderLabel>
                    );
                  })}
                  {tier.providers.length > visibleProviderLimit ? (
                    <span className="shrink-0 text-sm">+{tier.providers.length - visibleProviderLimit}</span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

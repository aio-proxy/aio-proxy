import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardHeader } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { canEditProvider } from '../../lib/provider-list-view';
import type { ProviderHealth } from '../../services/provider-health-service';
import { providerQuotaQueryOptions } from '../../services/provider-quota-service';
import type { ProviderUsage } from '../../services/provider-usage-service';
import { DiagnosticDetails } from '../diagnostic-details';
import { ProviderQuotaRing } from '../provider-quota-ring';
import { ProviderCardFooter } from './provider-card-footer';
import { ProviderCardIdentity } from './provider-card-identity';
import { ProviderCardRouting, type ProviderCardRoutingProps } from './provider-card-routing';
import { ProviderCardStats } from './provider-card-stats';

interface ProviderCardProps {
  readonly provider: DashboardProviderSummary;
  readonly routing: ProviderCardRoutingProps | undefined;
  readonly health: ProviderHealth | undefined;
  readonly usage: ProviderUsage | undefined;
  readonly usagePending: boolean;
  readonly pluginLabel: string | undefined;
  readonly pluginIcon: string | undefined;
  readonly focused: boolean;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({
  provider,
  routing,
  health,
  usage,
  usagePending,
  pluginLabel,
  pluginIcon,
  focused,
  onDelete,
}) => {
  const editable = canEditProvider(provider);
  const quotaQuery = useQuery({ ...providerQuotaQueryOptions(provider.id), enabled: provider.hasQuota });
  // Disabling the query does not evict what it already cached, so a Provider ID reconfigured away from
  // quota support would keep rendering the previous account's plan until the cache expires.
  const plan = provider.hasQuota ? quotaQuery.data?.snapshot.plan : undefined;

  return (
    <div
      id={`provider-row-${provider.id}`}
      data-testid={`provider-row-${provider.id}`}
      // A card with no identity link (an unparseable Provider) is the deep-link focus fallback, so
      // it has to be programmatically focusable without entering the tab order.
      {...(editable ? {} : { tabIndex: -1 })}
      data-focused={focused ? 'true' : undefined}
      className="relative isolate flex min-w-0 flex-col"
    >
      <Card
        size="sm"
        className={cn(
          // Keep the main surface unpositioned so the identity link's overlay anchors to the wrapper
          // and also covers the routing layer. As a flex item, z-10 still places this surface in front.
          'z-10 flex-1 overflow-visible transition-shadow',
          editable && 'focus-within:ring-2 focus-within:ring-ring/40 hover:shadow-md',
          provider.state.status === 'unavailable' && 'border border-destructive/60',
          // Mix onto an opaque card surface so the overlapping routing layer cannot show through.
          // Tint only the background to keep disabled text readable.
          provider.enabled === false && 'bg-[color-mix(in_oklab,var(--muted)_40%,var(--card))]',
          provider.kind === 'invalid' && 'border border-dashed border-destructive',
          focused && 'bg-accent ring-2 ring-ring/40',
        )}
      >
        {/* `CardHeader` is a grid that switches to `[1fr_auto]` as soon as it contains a
          `CardAction`, which is exactly the identity-plus-quota split. */}
        <CardHeader>
          <ProviderCardIdentity
            provider={provider}
            pluginLabel={pluginLabel}
            pluginIcon={pluginIcon}
            plan={plan === undefined ? undefined : resolveDashboardText(plan)}
            planPending={provider.hasQuota && quotaQuery.isPending}
            editable={editable}
          />
          {provider.hasQuota ? (
            <CardAction className={cn('relative z-10', provider.enabled === false && 'grayscale')}>
              <ProviderQuotaRing provider={provider} pluginLabel={pluginLabel} pluginIcon={pluginIcon} />
            </CardAction>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-3">
          {provider.kind === 'invalid' ? (
            <div className="space-y-2" data-testid="provider-card-invalid">
              <p className="text-sm text-destructive">{m['dashboard.providers.card.invalid_hint']()}</p>
              <code className="block rounded-md bg-destructive/10 p-2 text-xs whitespace-normal">{provider.id}</code>
              {provider.state.status === 'unavailable' ? (
                // The parse failure's own reason. Without it the card says only "invalid" and the
                // Provider cannot be edited, so there would be nowhere left to learn what broke.
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/10 p-2"
                  data-testid="provider-card-diagnostic"
                >
                  <DiagnosticDetails diagnostic={provider.state.diagnostic} />
                </div>
              ) : null}
              <div className="relative z-10 flex justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid="provider-card-delete"
                  onClick={() => onDelete(provider)}
                >
                  {m['dashboard.providers.actions.delete']()}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {provider.state.status === 'unavailable' ? (
                // Deliberately not elevated: raising noninteractive text above the identity link's
                // full-card `::after` overlay would punch a dead hole in the card's click target.
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/10 p-2"
                  data-testid="provider-card-diagnostic"
                >
                  <DiagnosticDetails diagnostic={provider.state.diagnostic} />
                </div>
              ) : null}
              <ProviderCardStats health={health} usage={usage} usagePending={usagePending} />
            </>
          )}
        </CardContent>

        {/* `CardFooter` is a sibling of `CardContent`, not a child: each Card slot supplies its own
          horizontal padding, and the Card's own `gap` is what separates them. */}
        {provider.kind === 'invalid' ? null : (
          <ProviderCardFooter provider={provider} editable={editable} onDelete={onDelete} />
        )}
      </Card>
      {provider.kind === 'invalid' || routing === undefined ? null : <ProviderCardRouting {...routing} />}
    </div>
  );
};

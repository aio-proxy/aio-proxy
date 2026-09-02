import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
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
import { ProviderCardStats } from './provider-card-stats';

interface ProviderCardProps {
  readonly provider: DashboardProviderSummary;
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
  const plan = quotaQuery.data?.snapshot.plan;

  return (
    <Card
      size="sm"
      id={`provider-row-${provider.id}`}
      data-testid={`provider-row-${provider.id}`}
      // A card with no identity link (an unparseable Provider) is the deep-link focus fallback, so
      // it has to be programmatically focusable without entering the tab order.
      {...(editable ? {} : { tabIndex: -1 })}
      data-focused={focused ? 'true' : undefined}
      className={cn(
        // `relative` anchors the identity link's full-card overlay; `overflow-visible` keeps the
        // focus ring from being clipped by the Card's own `overflow-hidden`.
        'relative gap-3 overflow-visible transition-shadow',
        editable && 'focus-within:ring-2 focus-within:ring-ring/40 hover:shadow-md',
        provider.state.status === 'unavailable' && 'border border-destructive/60',
        // A tint rather than `opacity`: dimming the whole card would take its body text below the
        // contrast floor. The icons already grayscale and the switch already reads as off.
        provider.enabled === false && 'bg-muted/40',
        provider.kind === 'invalid' && 'border border-dashed border-destructive',
        focused && 'bg-accent ring-2 ring-ring/40',
      )}
    >
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <ProviderCardIdentity
            provider={provider}
            pluginLabel={pluginLabel}
            pluginIcon={pluginIcon}
            plan={plan === undefined ? undefined : resolveDashboardText(plan)}
            planPending={provider.hasQuota && quotaQuery.isPending}
            editable={editable}
          />
          {provider.hasQuota ? (
            <div className={cn('relative z-10 shrink-0', provider.enabled === false && 'grayscale')}>
              <ProviderQuotaRing provider={provider} pluginLabel={pluginLabel} pluginIcon={pluginIcon} />
            </div>
          ) : null}
        </div>

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
            <ProviderCardStats provider={provider} health={health} />
          </>
        )}
      </CardContent>

      {/* `CardFooter` is a sibling of `CardContent`, not a child: each Card slot supplies its own
          horizontal padding, and the Card's own `gap` is what separates them. */}
      {provider.kind === 'invalid' ? null : (
        <ProviderCardFooter
          provider={provider}
          usage={usage}
          usagePending={usagePending}
          editable={editable}
          onDelete={onDelete}
        />
      )}
    </Card>
  );
};

import { m } from '@aio-proxy/i18n';
import { type DashboardProviderSummary, ProviderKind } from '@aio-proxy/types';
import { CardDescription } from '@aio-proxy/ui/components/card';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { cn } from '@aio-proxy/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import type React from 'react';

import { PROVIDER_FRAME_SIZE, PROVIDER_KIND_LABEL } from '../../lib/constants';
import { providerDisplayName } from '../../lib/provider-list-view';
import { ProviderAvatar } from '../provider-avatar';
import { ProviderProtocolLabels } from '../provider-protocol-labels';
import { ProviderProtocolStack } from '../provider-protocol-stack';

interface ProviderCardIdentityProps {
  readonly provider: DashboardProviderSummary;
  readonly pluginLabel: string | undefined;
  readonly pluginIcon: string | undefined;
  readonly plan: string | undefined;
  readonly planPending: boolean;
  readonly editable: boolean;
}

export const ProviderCardIdentity: React.FC<ProviderCardIdentityProps> = ({
  provider,
  pluginLabel,
  pluginIcon,
  plan,
  planPending,
  editable,
}) => {
  const name = providerDisplayName(provider);
  const kindLabel =
    provider.kind === 'invalid' ? m['dashboard.providers.kind_label.invalid']() : PROVIDER_KIND_LABEL[provider.kind];
  // A `ready` provider can still carry a diagnostic (e.g. a stale catalog). That is a hint, not a
  // failure: the red box is reserved for `unavailable`.
  const hint = provider.state.status === 'ready' ? provider.state.diagnostic : undefined;

  return (
    // Fragment, not a wrapper: these are rows of the `CardHeader` grid, so line 2 starts at the
    // card's own left edge instead of being indented under the name by the icon's column.
    <>
      <div className="flex min-w-0 items-center gap-2">
        {provider.kind === 'invalid' ? (
          <AlertTriangle
            style={{ width: PROVIDER_FRAME_SIZE, height: PROVIDER_FRAME_SIZE }}
            className="shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : provider.kind === ProviderKind.Api && provider.protocols.length > 0 ? (
          <ProviderProtocolStack
            protocols={provider.protocols}
            className={cn('shrink-0', provider.enabled === false && 'grayscale')}
          />
        ) : (
          <ProviderAvatar
            name={name}
            icon={pluginIcon}
            size={PROVIDER_FRAME_SIZE}
            className={cn(provider.enabled === false && 'grayscale')}
          />
        )}

        {/* `::after` stretches this link over the whole card, so the card is clickable without being
            a nested-interactive button. The controls sit at `z-10` and stay above it. */}
        {editable ? (
          <Link
            id={`provider-link-${provider.id}`}
            data-testid={`provider-link-${provider.id}`}
            to="/providers/$id/edit"
            params={{ id: provider.id }}
            title={provider.id}
            className="truncate font-medium after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline"
          >
            {name}
          </Link>
        ) : (
          <div className="truncate font-medium" title={provider.id}>
            {name}
          </div>
        )}
      </div>

      {/* One line, always: `nowrap` plus `min-w-0` on the parts that carry free-form text, so a long
          plugin name or package ellipsizes instead of pushing the line into a second row. */}
      <CardDescription
        className="flex min-w-0 flex-nowrap items-center gap-x-1 text-xs"
        data-testid="provider-card-detail"
      >
        <span className="shrink-0">{kindLabel}</span>
        {provider.kind === ProviderKind.Api && provider.protocols.length > 0 ? (
          <>
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
            <span className="min-w-0 truncate">
              <ProviderProtocolLabels protocols={provider.protocols} />
            </span>
          </>
        ) : null}
        {provider.kind === ProviderKind.OAuth && (pluginLabel ?? provider.plugin) !== undefined ? (
          <>
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
            <span className="min-w-0 truncate">{pluginLabel ?? provider.plugin}</span>
          </>
        ) : null}
        {provider.kind === ProviderKind.AiSdk && provider.packageName !== undefined ? (
          <>
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
            <span className="min-w-0 truncate">{provider.packageName}</span>
          </>
        ) : null}
        {planPending ? (
          <Skeleton className="h-3 w-12 shrink-0" data-testid="provider-plan-loading" />
        ) : plan === undefined ? null : (
          <>
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
            <span className="min-w-0 truncate">{plan}</span>
          </>
        )}
      </CardDescription>

      {hint === undefined ? null : (
        <p className="truncate text-xs text-amber-600 dark:text-amber-500" data-testid="provider-card-diagnostic-hint">
          {hint.summary}
        </p>
      )}
    </>
  );
};

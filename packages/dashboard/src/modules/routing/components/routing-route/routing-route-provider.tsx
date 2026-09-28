import { m } from '@aio-proxy/i18n';
import { type DashboardRoutingProvider, ProviderKind } from '@aio-proxy/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { ProtocolLabel } from '@/components/protocol-label';
import { ProviderAvatar } from '@/components/provider-avatar';
import { ProviderLabel, type ProviderLabelView } from '@/components/provider-label';
import { ProviderMark } from '@/components/provider-mark';
import { PROVIDER_FRAME_SIZE } from '@/lib/provider-frame';

const percentFormatter = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });

/** How this Provider splits its tier with others. Absent when it is alone in its tier or ineligible. */
export interface RoutingRouteProviderShare {
  /** The tier-local label from `formatTierShares`. */
  readonly label: string;
  readonly swatchClassName: string;
  /** Measured share within the tier, when the tier has traffic. */
  readonly actual: number | undefined;
  /** Set only when the measured share ran past the deviation threshold. */
  readonly deviation: number | undefined;
}

interface RoutingRouteProviderProps {
  readonly providerId: string;
  readonly routing: DashboardRoutingProvider | undefined;
  readonly share?: RoutingRouteProviderShare;
  readonly ineligibleReason?: string;
}

/**
 * OAuth Providers are recognized by service first and account second; API Providers by name and the
 * protocol they speak; AI SDK Providers by name and package.
 */
const identity = (view: ProviderLabelView): { readonly title: string; readonly detail: React.ReactNode } => {
  const provider = view.provider;
  if (provider?.kind === ProviderKind.OAuth) {
    // The service leads even when a name is configured: OAuth names are usually the account itself,
    // and a list of bare emails hides which upstream each one is.
    const title = view.oauthService ?? view.name;
    const detail = provider.name ?? view.accountLabel;
    return { title, detail: detail === title ? undefined : detail };
  }
  if (provider?.kind === ProviderKind.Api && provider.protocols[0] !== undefined) {
    const extra = provider.protocols.length - 1;
    return {
      title: view.name,
      detail: (
        <>
          <ProtocolLabel protocol={provider.protocols[0]} />
          {extra > 0 ? ` +${extra}` : null}
        </>
      ),
    };
  }
  if (provider?.kind === ProviderKind.AiSdk) return { title: view.name, detail: provider.packageName };
  return { title: view.name, detail: undefined };
};

const weightLine = (routing: DashboardRoutingProvider): string => {
  const fromModel = routing.effective.weightSource === 'model';
  const number = fromModel ? routing.override?.weight : routing.defaults.weight;
  const weight =
    number?.wasNormalized === true && number.authored !== undefined
      ? m['dashboard.routing.route.weight_normalized']({ effective: number.effective, authored: number.authored })
      : m['dashboard.routing.route.weight']({ value: routing.effective.weight });
  const source = fromModel
    ? m['dashboard.routing.route.source_model']()
    : m['dashboard.routing.route.source_provider']();
  return `${weight} · ${source}`;
};

export const RoutingRouteProvider: React.FC<RoutingRouteProviderProps> = ({
  providerId,
  routing,
  share,
  ineligibleReason,
}) => {
  const overridden =
    routing !== undefined &&
    (routing.effective.weightSource === 'model' || routing.effective.prioritySource === 'model');

  return (
    <ProviderLabel providerId={providerId}>
      {(view) => {
        const { title, detail } = identity(view);
        return (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  data-testid={`routing-route-provider-${providerId}`}
                  className={cn(
                    'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border py-0.5 pr-1 pl-0.5 text-sm whitespace-nowrap',
                    ineligibleReason === undefined ? 'bg-background' : 'border-dashed text-muted-foreground',
                  )}
                />
              }
            >
              <span className={cn('inline-flex shrink-0', ineligibleReason !== undefined && 'opacity-50')}>
                {view.provider === undefined ? (
                  <ProviderAvatar name={view.name} icon={undefined} size={PROVIDER_FRAME_SIZE} />
                ) : (
                  <ProviderMark provider={view.provider} pluginIcon={view.pluginIcon} />
                )}
              </span>
              <span className={cn('min-w-0 truncate', ineligibleReason === undefined && 'font-medium')}>{title}</span>
              {detail === undefined ? null : (
                <span className="max-w-[22ch] min-w-0 truncate text-muted-foreground">{detail}</span>
              )}
              {ineligibleReason === undefined ? null : (
                <span className="shrink-0 px-1 text-xs">{ineligibleReason}</span>
              )}
              {share === undefined ? (
                overridden && ineligibleReason === undefined ? (
                  <span className="shrink-0 px-1 text-xs text-primary">{m['dashboard.routing.route.override']()}</span>
                ) : null
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-muted px-1.5 font-mono text-xs text-muted-foreground tabular-nums">
                  <span aria-hidden="true" className={cn('size-2 rounded-xs', share.swatchClassName)} />
                  <span className={cn('min-w-[4ch] text-right', overridden ? 'text-primary' : 'text-foreground')}>
                    {share.label}
                  </span>
                  {share.deviation === undefined ? null : (
                    <span className="text-destructive">→ {percentFormatter.format(share.deviation)}</span>
                  )}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent className="flex-col items-start gap-0.5">
              <span className="font-medium">
                {view.name}
                {view.kindLabel === undefined ? null : ` · ${view.kindLabel}`}
              </span>
              <span className="font-mono">{providerId}</span>
              {routing === undefined ? null : <span>{weightLine(routing)}</span>}
              {share === undefined ? null : <span>{m['dashboard.routing.route.share']({ value: share.label })}</span>}
              {share?.actual === undefined ? null : (
                <span>{m['dashboard.routing.route.actual']({ value: percentFormatter.format(share.actual) })}</span>
              )}
              {ineligibleReason === undefined ? null : <span>{ineligibleReason}</span>}
            </TooltipContent>
          </Tooltip>
        );
      }}
    </ProviderLabel>
  );
};

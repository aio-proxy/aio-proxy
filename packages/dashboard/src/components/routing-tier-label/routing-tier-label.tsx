import { m } from '@aio-proxy/i18n';
import type React from 'react';

import { RoutingTierMarker } from './routing-tier-marker';

interface RoutingTierLabelProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  readonly tier: number;
  readonly priority: number;
}

/**
 * The one tier marker every routing surface draws: `T1`, `T2`, … with the tier's priority and its
 * failover role on hover. T1 takes the primary tint because it is where traffic goes first.
 */
export const RoutingTierLabel: React.FC<RoutingTierLabelProps> = ({ tier, priority, ...props }) => (
  <RoutingTierMarker
    aria-label={m['dashboard.routing.tier_label.tier']({ value: tier })}
    {...props}
    variant={tier === 1 ? 'primary' : 'fallback'}
    tooltip={
      <>
        <span className="font-medium">
          {m['dashboard.routing.tier_label.tier']({ value: tier })} ·{' '}
          {m['dashboard.routing.tier_label.priority']({ value: priority })}
        </span>
        <span>
          {tier === 1 ? m['dashboard.routing.tier_label.primary']() : m['dashboard.routing.tier_label.fallback']()}
        </span>
      </>
    }
  >
    {m['dashboard.routing.tier_label.short']({ value: tier })}
  </RoutingTierMarker>
);

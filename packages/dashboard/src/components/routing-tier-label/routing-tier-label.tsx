import { m } from '@aio-proxy/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

interface RoutingTierLabelProps {
  readonly tier: number;
  readonly priority: number;
  readonly className?: string;
  readonly testId?: string;
}

export const RoutingTierLabel: React.FC<RoutingTierLabelProps> = ({ tier, priority, className, testId }) => (
  <Tooltip>
    <TooltipTrigger render={<span className={cn('cursor-help', className)} data-testid={testId} tabIndex={0} />}>
      {m['dashboard.routing.tier_label.tier']({ value: tier })}
    </TooltipTrigger>
    <TooltipContent>{m['dashboard.routing.tier_label.priority']({ value: priority })}</TooltipContent>
  </Tooltip>
);

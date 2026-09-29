import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import { cn } from '@aio-proxy/ui/lib/utils';
import { type VariantProps, cva } from 'class-variance-authority';
import type React from 'react';

const routingTierMarkerVariants = cva(
  'inline-flex h-5 min-w-8 shrink-0 cursor-help items-center justify-center rounded-md border px-1.5 font-mono text-xs',
  {
    variants: {
      variant: {
        primary: 'border-transparent bg-primary/10 text-primary',
        fallback: 'border-border text-muted-foreground',
        ineligible: 'border-dashed border-border text-muted-foreground',
      },
    },
  },
);

interface RoutingTierMarkerProps extends React.ComponentProps<'span'>, VariantProps<typeof routingTierMarkerVariants> {
  readonly tooltip: React.ReactNode;
}

/**
 * The frame every routing row starts with. Tier markers and the ineligible row's marker share it,
 * so the rows of a route line up and a change to one cannot leave the other behind. Native span
 * props (`aria-label`, `data-testid`, …) pass straight through to the marker.
 */
export const RoutingTierMarker: React.FC<RoutingTierMarkerProps> = ({ tooltip, variant, className, ...props }) => (
  <Tooltip>
    <TooltipTrigger
      render={<span tabIndex={0} {...props} className={cn(routingTierMarkerVariants({ variant }), className)} />}
    />
    <TooltipContent className="flex-col items-start gap-0.5">{tooltip}</TooltipContent>
  </Tooltip>
);

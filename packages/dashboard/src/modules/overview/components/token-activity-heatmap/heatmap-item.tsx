import { cn } from '@aio-proxy/ui/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

import type { ActivityIntensity } from './activity-intensity';

const heatmapItemVariants = cva('size-4 rounded-xs', {
  variants: {
    intensity: {
      0: 'bg-muted/70',
      1: 'bg-primary/15',
      2: 'bg-primary/35',
      3: 'bg-primary/60',
      4: 'bg-primary',
    },
  },
});

interface HeatmapItemProps extends React.ComponentProps<'div'>, VariantProps<typeof heatmapItemVariants> {}

export const heatmapIntensities: readonly ActivityIntensity[] = [0, 1, 2, 3, 4];

export const HeatmapItem: React.FC<HeatmapItemProps> = ({ intensity = 0, className, ...props }) => (
  <div className={cn(heatmapItemVariants({ intensity }), className)} {...props} />
);

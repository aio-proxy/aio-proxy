import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';
import { GripVertical } from 'lucide-react';
import type React from 'react';

import type { WeightedTierBoardLabels } from './weighted-tier-board';

interface WeightedTierHeaderProps {
  readonly handleRef?: (element: Element | null) => void;
  readonly index: number;
  readonly itemCount: number;
  readonly labels: WeightedTierBoardLabels;
  readonly preview?: boolean;
  readonly writable: boolean;
}

export const WeightedTierHeader: React.FC<WeightedTierHeaderProps> = ({
  handleRef,
  index,
  itemCount,
  labels,
  preview = false,
  writable,
}) => (
  <div className="flex items-center gap-3" data-testid={preview ? 'weighted-tier-preview' : undefined}>
    {writable || preview ? (
      <Button
        ref={handleRef}
        type="button"
        size="sm"
        variant="secondary"
        tabIndex={preview ? -1 : undefined}
        aria-hidden={preview || undefined}
        aria-label={preview ? undefined : labels.dragTier(index)}
        className={cn('cursor-grab active:cursor-grabbing', preview && 'pointer-events-none')}
      >
        <GripVertical />
        {index + 1}
      </Button>
    ) : null}
    <h3 className="min-w-0 flex-1 font-heading text-sm font-medium">{labels.tier(index)}</h3>
    <span className="text-xs text-muted-foreground">{labels.tierCount(itemCount)}</span>
  </div>
);

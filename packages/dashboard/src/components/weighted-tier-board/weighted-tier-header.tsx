import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';
import { GripVertical } from 'lucide-react';
import type React from 'react';

import type { WeightedTierBoardLabels } from './weighted-tier-board';

interface WeightedTierHeaderProps {
  readonly handleRef?: (element: Element | null) => void;
  readonly index: number;
  readonly labels: WeightedTierBoardLabels;
  readonly priority: number;
  readonly preview?: boolean;
  readonly writable: boolean;
}

export const WeightedTierHeader: React.FC<WeightedTierHeaderProps> = ({
  handleRef,
  index,
  labels,
  priority,
  preview = false,
  writable,
}) => (
  <div
    className="flex items-center gap-2.5 bg-muted px-2.5 py-2"
    data-testid={preview ? 'weighted-tier-preview' : undefined}
  >
    {writable || preview ? (
      <Button
        ref={handleRef}
        type="button"
        size="icon-sm"
        variant="ghost"
        tabIndex={preview ? -1 : undefined}
        aria-hidden={preview || undefined}
        aria-label={preview ? undefined : labels.dragTier(index)}
        className={cn('cursor-grab active:cursor-grabbing', 'text-muted-foreground', preview && 'pointer-events-none')}
      >
        <GripVertical />
      </Button>
    ) : null}
    <h3 className="min-w-0 flex-1 font-heading text-sm font-medium">{labels.tier(index, priority)}</h3>
  </div>
);

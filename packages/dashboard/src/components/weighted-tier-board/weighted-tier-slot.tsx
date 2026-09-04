import { cn } from '@aio-proxy/ui/lib/utils';
import { useDroppable } from '@dnd-kit/react';
import type React from 'react';

import type { WeightedTierBoardItem, WeightedTierBoardLabels } from './weighted-tier-board';
import { WeightedTierHeader } from './weighted-tier-header';
import { WeightedTierItem } from './weighted-tier-item';

interface WeightedTierSlotProps<TItem> {
  readonly items: readonly WeightedTierBoardItem<TItem>[];
  readonly labels: WeightedTierBoardLabels;
  readonly listId: string;
  readonly renderItem: (value: TItem) => React.ReactNode;
  readonly testId?: string;
  readonly tierPreview?: { readonly index: number; readonly itemCount: number };
}

export const WeightedTierSlot = <TItem,>({
  items,
  labels,
  listId,
  renderItem,
  testId,
  tierPreview,
}: WeightedTierSlotProps<TItem>): React.ReactElement => {
  const { ref, isDropTarget } = useDroppable({ id: listId, type: 'list', accept: ['item', 'tier'] });
  const occupied = items.length > 0 || tierPreview !== undefined;

  return (
    <section
      ref={ref}
      aria-label={labels.newTier}
      data-testid={testId}
      data-drop-target={isDropTarget || undefined}
      className={cn(
        'rounded-xl border-dashed transition-[min-height,border-color,background-color,padding] duration-150 motion-reduce:transition-none',
        occupied ? 'space-y-2 border border-primary bg-primary/5 p-2' : 'h-2',
        isDropTarget && 'min-h-14 border border-primary bg-primary/5 p-2',
      )}
    >
      {tierPreview === undefined ? null : (
        <WeightedTierHeader
          index={tierPreview.index}
          itemCount={tierPreview.itemCount}
          labels={labels}
          preview
          writable={false}
        />
      )}
      {items.map((item, index) => (
        <WeightedTierItem
          key={item.id}
          index={index}
          item={item}
          listId={listId}
          preview
          renderItem={renderItem}
          writable
        />
      ))}
    </section>
  );
};

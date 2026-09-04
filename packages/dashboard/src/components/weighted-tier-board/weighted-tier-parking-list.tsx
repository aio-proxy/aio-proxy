import { cn } from '@aio-proxy/ui/lib/utils';
import { useDroppable } from '@dnd-kit/react';
import type React from 'react';

import { weightedTierParkingId } from '@/lib/weighted-tier-layout';

import type { WeightedTierParkingList } from './weighted-tier-board';
import { WeightedTierItem } from './weighted-tier-item';

interface WeightedTierParkingListProps<TItem> {
  readonly list: WeightedTierParkingList<TItem>;
  readonly renderItem: (value: TItem) => React.ReactNode;
  readonly writable: boolean;
}

export const WeightedTierParkingList = <TItem,>({
  list,
  renderItem,
  writable,
}: WeightedTierParkingListProps<TItem>): React.ReactElement => {
  const listId = weightedTierParkingId(list.id);
  const { ref, isDropTarget } = useDroppable({
    id: listId,
    type: 'list',
    accept: 'item',
    disabled: !writable || !list.droppable,
  });

  return (
    <section
      ref={ref}
      aria-label={list.label}
      data-testid={list.testId}
      data-drop-target={isDropTarget || undefined}
      className={cn(
        'space-y-2 rounded-xl border bg-muted/40 p-3 transition-colors',
        isDropTarget && 'border-primary bg-primary/5',
      )}
    >
      <h3 className="text-sm">{list.label}</h3>
      <div className="space-y-2">
        {list.items.map((item, index) => (
          <WeightedTierItem
            key={item.id}
            index={index}
            item={item}
            listId={listId}
            renderItem={renderItem}
            writable={writable && list.droppable}
          />
        ))}
      </div>
    </section>
  );
};

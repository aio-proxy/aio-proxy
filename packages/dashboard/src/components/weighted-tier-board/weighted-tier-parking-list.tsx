import { cn } from '@aio-proxy/ui/lib/utils';
import { useDroppable } from '@dnd-kit/react';
import type React from 'react';

import { weightedTierParkingId } from '@/lib/weighted-tier-layout';

import type { WeightedTierParkingList as WeightedTierParkingListModel } from './weighted-tier-board';
import { WeightedTierItem } from './weighted-tier-item';

interface WeightedTierParkingListProps<TItem> {
  readonly list: WeightedTierParkingListModel<TItem>;
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
        'overflow-hidden rounded-xl border transition-colors',
        isDropTarget && 'border-primary bg-primary/5',
      )}
    >
      {/* The empty handle column keeps the heading under the tiers' labels, as the rows below it do. */}
      <div className="flex items-center gap-2.5 bg-muted px-2.5 py-2">
        {writable ? <span aria-hidden="true" className="size-7 shrink-0" /> : null}
        <h3 className="min-w-0 flex-1 text-sm">{list.heading ?? list.label}</h3>
      </div>
      <div>
        {list.items.map((item, index) => (
          <WeightedTierItem
            key={item.id}
            index={index}
            item={item}
            listId={listId}
            renderItem={renderItem}
            handleColumn={writable}
            writable={writable && list.droppable}
          />
        ))}
      </div>
    </section>
  );
};

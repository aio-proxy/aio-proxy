import { cn } from '@aio-proxy/ui/lib/utils';
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable';
import { useDragOperation, useDroppable } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import type React from 'react';

import { WEIGHTED_TIER_ORDER, weightedTierListId } from '@/lib/weighted-tier-layout';

import type { WeightedTierBoardItem, WeightedTierBoardLabels } from './weighted-tier-board';
import { WeightedTierHeader } from './weighted-tier-header';
import { WeightedTierItem } from './weighted-tier-item';

const SORTABLE_PLUGINS = [SortableKeyboardPlugin];

interface WeightedTierProps<TItem> {
  readonly id: string;
  readonly index: number;
  readonly items: readonly WeightedTierBoardItem<TItem>[];
  readonly labels: WeightedTierBoardLabels;
  readonly renderItem: (value: TItem) => React.ReactNode;
  readonly testId?: string;
  readonly writable: boolean;
}

export const WeightedTier = <TItem,>({
  id,
  index,
  items,
  labels,
  renderItem,
  testId,
  writable,
}: WeightedTierProps<TItem>): React.ReactElement => {
  const { source } = useDragOperation();
  const collapsed = source?.type === 'tier';
  const { ref, handleRef, isDragging } = useSortable({
    id,
    index,
    group: WEIGHTED_TIER_ORDER,
    type: 'tier',
    accept: [],
    disabled: !writable,
    plugins: SORTABLE_PLUGINS,
  });
  const listId = weightedTierListId(id);
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: listId,
    type: 'list',
    accept: 'item',
    disabled: !writable,
  });

  return (
    <section
      ref={ref}
      data-testid={testId}
      data-dragging={isDragging || undefined}
      data-drop-target={isDropTarget || undefined}
      className={cn(
        'space-y-2 rounded-xl border bg-muted/40 p-3 transition-colors',
        isDragging && 'opacity-0',
        isDropTarget && 'border-primary bg-primary/5',
      )}
    >
      <WeightedTierHeader
        handleRef={handleRef}
        index={index}
        itemCount={items.length}
        labels={labels}
        writable={writable}
      />
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div
          ref={dropRef}
          aria-hidden={collapsed || undefined}
          inert={collapsed || undefined}
          data-testid="weighted-tier-body"
          data-collapsed={collapsed || undefined}
          className={cn(
            'min-h-0 space-y-2 overflow-hidden',
            items.length === 0 && 'min-h-16 rounded-lg border border-dashed p-2',
          )}
        >
          {items.length === 0 ? (
            <p className="flex min-h-12 items-center justify-center text-xs text-muted-foreground">
              {labels.emptyTier}
            </p>
          ) : (
            items.map((item, itemIndex) => (
              <WeightedTierItem
                key={item.id}
                index={itemIndex}
                item={item}
                listId={listId}
                renderItem={renderItem}
                writable={writable}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
};

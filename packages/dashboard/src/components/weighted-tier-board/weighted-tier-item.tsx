import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable';
import { useSortable } from '@dnd-kit/react/sortable';
import { GripVertical } from 'lucide-react';
import type React from 'react';

import { weightedTierItemSortableId } from '@/lib/weighted-tier-layout';

import type { WeightedTierBoardItem as WeightedTierBoardItemModel } from './weighted-tier-board';

const SORTABLE_PLUGINS = [SortableKeyboardPlugin];

interface WeightedTierItemProps<TItem> {
  readonly index: number;
  readonly item: WeightedTierBoardItemModel<TItem>;
  readonly listId: string;
  readonly renderItem: (value: TItem) => React.ReactNode;
  /** The list holds a drag handle column even when this item has no handle. */
  readonly handleColumn?: boolean;
  readonly writable: boolean;
}

export const WeightedTierItem = <TItem,>({
  index,
  item,
  listId,
  renderItem,
  handleColumn = false,
  writable,
}: WeightedTierItemProps<TItem>): React.ReactElement => {
  const { ref, handleRef, isDragging } = useSortable({
    // Namespaced so a caller-supplied item ID never collides with a generated tier or list id.
    id: weightedTierItemSortableId(item.id),
    index,
    group: listId,
    type: 'item',
    accept: 'item',
    disabled: !writable || !item.draggable,
    plugins: SORTABLE_PLUGINS,
  });
  return (
    <div
      ref={ref}
      className={cn('border-t px-2.5 py-2', isDragging && 'opacity-70')}
      data-testid={item.testId}
      data-dragging={isDragging || undefined}
    >
      <div className="flex items-center gap-2.5">
        {writable && item.draggable ? (
          <Button
            ref={handleRef}
            type="button"
            size="icon-sm"
            variant="ghost"
            className="cursor-grab text-muted-foreground active:cursor-grabbing"
            aria-label={item.dragLabel}
          >
            <GripVertical />
          </Button>
        ) : handleColumn ? (
          <span aria-hidden="true" className="size-7 shrink-0" />
        ) : null}
        <div className="min-w-0 flex-1">{renderItem(item.value)}</div>
      </div>
    </div>
  );
};

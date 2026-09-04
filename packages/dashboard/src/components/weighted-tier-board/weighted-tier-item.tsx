import { Button } from '@aio-proxy/ui/components/button';
import { Slider } from '@aio-proxy/ui/components/slider';
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
  readonly preview?: boolean;
  readonly renderItem: (value: TItem) => React.ReactNode;
  readonly writable: boolean;
}

export const WeightedTierItem = <TItem,>({
  index,
  item,
  listId,
  preview = false,
  renderItem,
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
  const control = preview || !writable ? undefined : item.control;

  return (
    <div
      ref={ref}
      className={cn('space-y-2 rounded-lg bg-background px-3 py-2', isDragging && 'opacity-70')}
      data-testid={item.testId}
      data-dragging={isDragging || undefined}
    >
      <div className="flex items-center gap-3">
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
        ) : null}
        <div className="min-w-0 flex-1">{renderItem(item.value)}</div>
        {preview || item.shareLabel === undefined ? null : (
          <span className="shrink-0 text-sm text-muted-foreground" data-testid={item.shareTestId}>
            {item.shareLabel}
          </span>
        )}
      </div>
      {control === undefined ? null : (
        <Slider
          aria-label={control.ariaLabel}
          data-testid={control.testId}
          min={control.min}
          max={control.max}
          step={control.step}
          thumbAlignment="center"
          value={[control.value]}
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next === 'number') control.onChange(next);
          }}
        />
      )}
    </div>
  );
};

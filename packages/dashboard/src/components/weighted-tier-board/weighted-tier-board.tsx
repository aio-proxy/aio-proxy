import { defaultPreset } from '@dnd-kit/dom';
import { move } from '@dnd-kit/helpers';
import { DragDropProvider } from '@dnd-kit/react';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';

import {
  WEIGHTED_TIER_HIGH,
  projectWeightedTierLayout,
  weightedTierAfterSlotId,
  weightedTierIdFromSortable,
  weightedTierItemIdFromSortable,
  weightedTierListId,
  weightedTierLists,
  weightedTierParkingId,
  type WeightedTierLayout,
  type WeightedTierLists,
  type WeightedTierOperation,
} from '@/lib/weighted-tier-layout';

import { WeightedTier } from './weighted-tier';
import { WeightedTierParkingList as WeightedTierParkingListView } from './weighted-tier-parking-list';
import { WeightedTierSlot } from './weighted-tier-slot';

export interface WeightedTierBoardControl {
  readonly ariaLabel: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step?: number;
  readonly testId?: string;
  readonly value: number;
}

export interface WeightedTierBoardItem<TItem> {
  readonly control?: WeightedTierBoardControl;
  readonly dragLabel: string;
  readonly draggable: boolean;
  readonly id: string;
  readonly shareLabel?: string;
  readonly shareTestId?: string;
  readonly testId?: string;
  readonly value: TItem;
}

export interface WeightedTierBoardTier<TItem> {
  readonly id: string;
  readonly items: readonly WeightedTierBoardItem<TItem>[];
}

export interface WeightedTierParkingList<TItem> {
  readonly droppable: boolean;
  readonly id: string;
  readonly items: readonly WeightedTierBoardItem<TItem>[];
  readonly label: string;
  readonly testId?: string;
}

export interface WeightedTierBoardLabels {
  readonly dragTier: (index: number) => string;
  readonly emptyTier: string;
  readonly newTier: string;
  readonly tier: (index: number) => string;
  readonly tierCount: (count: number) => string;
}

interface WeightedTierBoardProps<TItem> {
  readonly labels: WeightedTierBoardLabels;
  readonly onLayoutChange: (layout: WeightedTierLayout, operation: WeightedTierOperation) => void;
  readonly parking?: readonly WeightedTierParkingList<TItem>[];
  readonly renderItem: (value: TItem) => React.ReactNode;
  readonly slotTestId?: (listId: string) => string;
  readonly testId?: string;
  readonly tierTestId?: (index: number, tierId: string) => string;
  readonly tiers: readonly WeightedTierBoardTier<TItem>[];
  readonly writable: boolean;
}

const listContaining = (lists: Readonly<Record<string, readonly string[]>>, id: string): string | undefined =>
  Object.keys(lists).find((key) => lists[key]?.includes(id));

export const WeightedTierBoard = <TItem,>({
  labels,
  onLayoutChange,
  parking = [],
  renderItem,
  slotTestId,
  testId = 'weighted-tier-board',
  tierTestId,
  tiers,
  writable,
}: WeightedTierBoardProps<TItem>): React.ReactElement => {
  const layout = useMemo<WeightedTierLayout>(
    () => ({
      tiers: tiers.map((tier) => ({ id: tier.id, itemIds: tier.items.map((item) => item.id) })),
      parking: Object.fromEntries(parking.map((list) => [list.id, list.items.map((item) => item.id)])),
    }),
    [parking, tiers],
  );
  const derivedLists = useMemo(() => weightedTierLists(layout), [layout]);
  const [dragLists, setDragLists] = useState<WeightedTierLists | null>(null);
  const dragListsRef = useRef<WeightedTierLists | null>(null);
  const snapshot = useRef(layout);
  const lists = dragLists ?? derivedLists;
  const itemsById = useMemo(
    () =>
      new Map(
        [...tiers.flatMap((tier) => tier.items), ...parking.flatMap((list) => list.items)].map((item) => [
          item.id,
          item,
        ]),
      ),
    [parking, tiers],
  );
  const tiersById = useMemo(() => new Map(tiers.map((tier, index) => [tier.id, { index, tier }])), [tiers]);
  // `lists` holds dnd-kit sortable ids; a slot can hold either an item's or a whole tier's, so each
  // lookup translates only its own namespace and ignores the other.
  const itemsFor = (ids: readonly string[]): WeightedTierBoardItem<TItem>[] =>
    ids.flatMap((id) => {
      const item = itemsById.get(weightedTierItemIdFromSortable(id) ?? '');
      return item === undefined ? [] : [item];
    });
  const previewFor = (listId: string): { readonly index: number; readonly itemCount: number } | undefined => {
    const preview = tiersById.get(weightedTierIdFromSortable(lists[listId]?.[0] ?? '') ?? '');
    return preview === undefined ? undefined : { index: preview.index, itemCount: preview.tier.items.length };
  };

  return (
    <DragDropProvider
      plugins={defaultPreset.plugins}
      sensors={defaultPreset.sensors}
      onDragStart={() => {
        snapshot.current = layout;
        dragListsRef.current = derivedLists;
        setDragLists(derivedLists);
      }}
      onDragOver={(event) => {
        const source = event.operation.source;
        if (source?.type !== 'item' && source?.type !== 'tier') return;
        const current = dragListsRef.current ?? derivedLists;
        const next = move(current, event);
        if (listContaining(current, String(source.id)) === listContaining(next, String(source.id))) return;
        dragListsRef.current = next;
        setDragLists(next);
      }}
      onDragEnd={(event) => {
        const source = event.operation.source;
        const nextLists = dragListsRef.current ?? derivedLists;
        dragListsRef.current = null;
        setDragLists(null);
        if (event.canceled || (source?.type !== 'item' && source?.type !== 'tier')) return;
        // dnd-kit reports namespaced sortable ids; the layout speaks domain tier and item IDs.
        const sourceId = String(source.id);
        const id =
          source.type === 'tier' ? weightedTierIdFromSortable(sourceId) : weightedTierItemIdFromSortable(sourceId);
        if (id === undefined) return;
        const operation: WeightedTierOperation = { type: source.type, id };
        const next = projectWeightedTierLayout(snapshot.current, nextLists, operation);
        if (next !== snapshot.current) onLayoutChange(next, operation);
      }}
    >
      <div className="space-y-0" data-testid={testId}>
        {writable ? (
          <WeightedTierSlot
            listId={WEIGHTED_TIER_HIGH}
            items={itemsFor(lists[WEIGHTED_TIER_HIGH] ?? [])}
            labels={labels}
            renderItem={renderItem}
            testId={slotTestId?.(WEIGHTED_TIER_HIGH)}
            tierPreview={previewFor(WEIGHTED_TIER_HIGH)}
          />
        ) : null}
        {tiers.map((tier, index) => {
          const listId = weightedTierListId(tier.id);
          const afterId = weightedTierAfterSlotId(tier.id);
          return (
            <div key={tier.id}>
              <WeightedTier
                id={tier.id}
                index={index}
                items={itemsFor(lists[listId] ?? [])}
                labels={labels}
                renderItem={renderItem}
                testId={tierTestId?.(index, tier.id)}
                writable={writable}
              />
              {writable ? (
                <WeightedTierSlot
                  listId={afterId}
                  items={itemsFor(lists[afterId] ?? [])}
                  labels={labels}
                  renderItem={renderItem}
                  testId={slotTestId?.(afterId)}
                  tierPreview={previewFor(afterId)}
                />
              ) : null}
            </div>
          );
        })}
        {parking.map((list) => (
          <WeightedTierParkingListView
            key={list.id}
            list={{ ...list, items: itemsFor(lists[weightedTierParkingId(list.id)] ?? []) }}
            renderItem={renderItem}
            writable={writable}
          />
        ))}
      </div>
    </DragDropProvider>
  );
};

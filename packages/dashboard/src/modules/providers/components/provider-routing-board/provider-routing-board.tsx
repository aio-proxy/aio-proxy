import type { DashboardProviderSummary } from '@aio-proxy/types';
import { defaultPreset } from '@dnd-kit/dom';
import { move } from '@dnd-kit/helpers';
import { DragDropProvider } from '@dnd-kit/react';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';

import {
  applyProviderMove,
  applyProviderShare,
  applyProviderTierOrder,
  PROVIDER_TIER_HIGH,
  PROVIDER_TIER_ORDER,
  providerTierAfterListId,
  providerRoutingLists,
  providerTierListId,
  type ProviderRoutingBoard as ProviderRoutingBoardModel,
  type ProviderRoutingBoardItem,
} from '../../lib/provider-routing-board';
import { ProviderTier } from './provider-tier';
import { ProviderTierFlow } from './provider-tier-flow';
import { ProviderTierSlot } from './provider-tier-slot';

interface ProviderRoutingBoardProps {
  readonly board: ProviderRoutingBoardModel;
  readonly providers: readonly DashboardProviderSummary[];
  readonly onChange: (board: ProviderRoutingBoardModel) => void;
}

const listContaining = (lists: Readonly<Record<string, readonly string[]>>, itemId: string): string | undefined =>
  Object.keys(lists).find((key) => lists[key]?.includes(itemId));

export const ProviderRoutingBoard: React.FC<ProviderRoutingBoardProps> = ({ board, providers, onChange }) => {
  const snapshotBoard = useRef(board);
  const derivedLists = useMemo(() => providerRoutingLists(board), [board]);
  const [dragLists, setDragLists] = useState<ReturnType<typeof providerRoutingLists> | null>(null);
  const dragListsRef = useRef<ReturnType<typeof providerRoutingLists> | null>(null);
  const lists = dragLists ?? derivedLists;
  const providersById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const itemsById = useMemo(
    () => new Map(board.tiers.flatMap((tier) => tier.items.map((item) => [item.providerId, item] as const))),
    [board],
  );
  const itemsFor = (ids: readonly string[]): ProviderRoutingBoardItem[] =>
    ids.flatMap((id) => (itemsById.get(id) === undefined ? [] : [itemsById.get(id)!]));

  return (
    <DragDropProvider
      plugins={defaultPreset.plugins}
      sensors={defaultPreset.sensors}
      onDragStart={() => {
        snapshotBoard.current = board;
        dragListsRef.current = derivedLists;
        setDragLists(derivedLists);
      }}
      onDragOver={(event) => {
        if (event.operation.source?.type !== 'provider') return;
        const current = dragListsRef.current ?? derivedLists;
        const next = move(current, event);
        const providerId = String(event.operation.source.id);
        if (listContaining(current, providerId) === listContaining(next, providerId)) return;
        dragListsRef.current = next;
        setDragLists(next);
      }}
      onDragEnd={(event) => {
        const source = event.operation.source;
        const providerLists = dragListsRef.current ?? derivedLists;
        dragListsRef.current = null;
        setDragLists(null);
        if (event.canceled || source === null) return;
        const next = source.type === 'tier' ? move(providerRoutingLists(snapshotBoard.current), event) : providerLists;
        if (source.type === 'tier') {
          onChange(applyProviderTierOrder(snapshotBoard.current, next[PROVIDER_TIER_ORDER] ?? []));
          return;
        }
        if (source.type === 'provider') {
          onChange(applyProviderMove(snapshotBoard.current, next, String(source.id)));
        }
      }}
    >
      <div className="space-y-0" data-testid="provider-routing-board">
        <ProviderTierSlot
          listId={PROVIDER_TIER_HIGH}
          items={itemsFor(lists[PROVIDER_TIER_HIGH] ?? [])}
          providersById={providersById}
        />
        {board.tiers.map((tier, index) => (
          <div key={tier.id}>
            <ProviderTier
              tier={{ ...tier, items: itemsFor(lists[providerTierListId(tier.id)] ?? []) }}
              tierIndex={index}
              providersById={providersById}
              onShareChange={(providerId, share) => onChange(applyProviderShare(board, tier.id, providerId, share))}
            />
            {index < board.tiers.length - 1 ? <ProviderTierFlow /> : null}
            <ProviderTierSlot
              listId={providerTierAfterListId(tier.id)}
              items={itemsFor(lists[providerTierAfterListId(tier.id)] ?? [])}
              providersById={providersById}
            />
          </div>
        ))}
      </div>
    </DragDropProvider>
  );
};

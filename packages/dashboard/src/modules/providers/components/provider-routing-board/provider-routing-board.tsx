import type { DashboardProviderSummary } from '@aio-proxy/types';
import { defaultPreset } from '@dnd-kit/dom';
import { move } from '@dnd-kit/helpers';
import { DragDropProvider } from '@dnd-kit/react';
import type React from 'react';
import { useMemo, useRef } from 'react';

import {
  applyProviderMove,
  applyProviderShare,
  applyProviderTierOrder,
  PROVIDER_TIER_ORDER,
  providerRoutingLists,
  type ProviderRoutingBoard as ProviderRoutingBoardModel,
} from '../../lib/provider-routing-board';
import { ProviderTier } from './provider-tier';
import { ProviderTierFlow } from './provider-tier-flow';

interface ProviderRoutingBoardProps {
  readonly board: ProviderRoutingBoardModel;
  readonly providers: readonly DashboardProviderSummary[];
  readonly onChange: (board: ProviderRoutingBoardModel) => void;
}

export const ProviderRoutingBoard: React.FC<ProviderRoutingBoardProps> = ({ board, providers, onChange }) => {
  const snapshotBoard = useRef(board);
  const providersById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  return (
    <DragDropProvider
      plugins={defaultPreset.plugins}
      sensors={defaultPreset.sensors}
      onDragStart={() => {
        snapshotBoard.current = board;
      }}
      onDragEnd={(event) => {
        if (event.canceled || event.operation.source === null) return;
        const next = move(providerRoutingLists(snapshotBoard.current), event);
        if (event.operation.source.type === 'tier') {
          onChange(applyProviderTierOrder(snapshotBoard.current, next[PROVIDER_TIER_ORDER] ?? []));
          return;
        }
        if (event.operation.source.type === 'provider') {
          onChange(applyProviderMove(snapshotBoard.current, next, String(event.operation.source.id)));
        }
      }}
    >
      <div className="space-y-0" data-testid="provider-routing-board">
        {board.tiers.map((tier, index) => (
          <div key={tier.id}>
            <ProviderTier
              tier={tier}
              tierIndex={index}
              providersById={providersById}
              onShareChange={(providerId, share) => onChange(applyProviderShare(board, tier.id, providerId, share))}
            />
            {index < board.tiers.length - 1 ? <ProviderTierFlow /> : null}
          </div>
        ))}
      </div>
    </DragDropProvider>
  );
};

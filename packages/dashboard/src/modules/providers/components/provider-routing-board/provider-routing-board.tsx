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
import type { ProviderHealth } from '../../services/provider-health-service';
import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderTier } from './provider-tier';
import { ProviderTierFlow } from './provider-tier-flow';

interface ProviderRoutingBoardProps {
  readonly board: ProviderRoutingBoardModel;
  readonly providers: readonly DashboardProviderSummary[];
  readonly visibleProviderIds: ReadonlySet<string>;
  readonly editing: boolean;
  readonly health: ReadonlyMap<string, ProviderHealth> | undefined;
  readonly usage: ReadonlyMap<string, ProviderUsage> | undefined;
  readonly usagePending: boolean;
  readonly pluginPresentations: ReadonlyMap<string, { readonly displayName?: string; readonly icon?: string }>;
  readonly focusedProviderId: string | undefined;
  readonly onChange: (board: ProviderRoutingBoardModel) => void;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderRoutingBoard: React.FC<ProviderRoutingBoardProps> = ({
  board,
  providers,
  visibleProviderIds,
  editing,
  health,
  usage,
  usagePending,
  pluginPresentations,
  focusedProviderId,
  onChange,
  onDelete,
}) => {
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
        {board.tiers.map((tier, index) => {
          const visible = editing || tier.items.some((item) => visibleProviderIds.has(item.providerId));
          if (!visible) return null;
          return (
            <div key={tier.id}>
              <ProviderTier
                tier={tier}
                tierIndex={index}
                providersById={providersById}
                visibleProviderIds={visibleProviderIds}
                editing={editing}
                health={health}
                usage={usage}
                usagePending={usagePending}
                pluginPresentations={pluginPresentations}
                focusedProviderId={focusedProviderId}
                onShareChange={(providerId, share) => onChange(applyProviderShare(board, tier.id, providerId, share))}
                onDelete={onDelete}
              />
              {index < board.tiers.length - 1 ? <ProviderTierFlow /> : null}
            </div>
          );
        })}
      </div>
    </DragDropProvider>
  );
};

import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, DashboardRoutingProvider, RouterSelection } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useMemo } from 'react';

import { RoutingTierLabel, RoutingTierMarker } from '@/components/routing-tier-label';
import {
  WeightedTierBoard,
  type WeightedTierBoardItem,
  type WeightedTierBoardTier,
  type WeightedTierParkingList,
} from '@/components/weighted-tier-board';

import type { RoutingFormProviderRow, useRoutingForm } from '../hooks/use-routing-form';
import {
  applyRoutingBoardLayout,
  applyRoutingWeight,
  buildRoutingBoard,
  moveRoutingProvider,
  providersWithSavedTierMembers,
  routingBoardLayout,
  type RoutingBoardItem as RoutingBoardItemModel,
  type RoutingMoveTarget,
} from '../lib/routing-board';
import { formatTierShares } from '../lib/routing-summary';
import type { RoutingTierShare } from '../lib/routing-traffic';
import { RoutingBoardColumns } from './routing-board-columns';
import { RoutingBoardItem, type RoutingBoardMoveOption } from './routing-board-item';

interface RoutingBoardCanvasProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly rows: readonly RoutingFormProviderRow[];
  readonly writable: boolean;
  readonly actual?: readonly RoutingTierShare[] | undefined;
  readonly selection?: RouterSelection;
}

type Placement =
  | { readonly kind: 'tier'; readonly index: number; readonly shareLabel: string | undefined }
  | {
      readonly kind: 'unused' | 'blocked';
    };

interface RoutingBoardItemView {
  readonly provider: DashboardRoutingProvider;
  readonly item: RoutingBoardItemModel;
  readonly rowIndex: number;
  readonly hasOverride: boolean;
  readonly placement: Placement;
}

const SEGMENT_CLASSES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const;

const parkingHeading = (label: string): React.ReactNode => (
  <span className="flex items-center gap-2.5">
    <RoutingTierMarker variant="ineligible" tooltip={label}>
      —
    </RoutingTierMarker>
    <span className="text-muted-foreground">{label}</span>
  </span>
);

const blockedReason = (provider: DashboardRoutingProvider): string =>
  provider.enabled
    ? m['dashboard.routing.editor.provider_unavailable']()
    : m['dashboard.routing.editor.provider_disabled']();

export const RoutingBoardCanvas: React.FC<RoutingBoardCanvasProps> = ({
  form,
  model,
  rows,
  writable,
  actual,
  selection = 'weighted',
}) => {
  const board = useMemo(() => buildRoutingBoard(model.providers, rows), [model.providers, rows]);
  const actualByProviderId = useMemo(
    () => (actual === undefined ? undefined : new Map(actual.map((entry) => [entry.providerId, entry]))),
    [actual],
  );
  // Only these Providers may show the configured-versus-actual reading: for the rest the draft has
  // moved them to a tier the measurement was never taken over.
  const comparableShares = useMemo(() => providersWithSavedTierMembers(model.tiers, board), [model.tiers, board]);
  const providersById = new Map(model.providers.map((provider) => [provider.id, provider]));
  const rowsById = new Map(
    rows.map((row, index) => [
      row.providerId,
      { rowIndex: index, hasOverride: row.priority !== undefined || row.weight !== undefined },
    ]),
  );
  const setRows = (next: RoutingFormProviderRow[]) => form.setFieldValue('providers', next);
  const move = (providerId: string, target: RoutingMoveTarget) =>
    setRows(moveRoutingProvider({ providers: model.providers, rows, board, providerId, target }));

  const toItem = (item: RoutingBoardItemModel, placement: Placement): WeightedTierBoardItem<RoutingBoardItemView>[] => {
    const provider = providersById.get(item.providerId);
    const row = rowsById.get(item.providerId);
    if (provider === undefined || row === undefined) return [];
    return [
      {
        id: item.providerId,
        value: { provider, item, placement, ...row },
        draggable: item.draggable,
        dragLabel: m['dashboard.providers.routing.drag_provider']({ providerId: item.providerId }),
        testId: `routing-provider-${item.providerId}`,
      },
    ];
  };
  const tiers: WeightedTierBoardTier<RoutingBoardItemView>[] = board.tiers.map((tier, index) => {
    const labels = formatTierShares(tier.items.map((item) => item.share ?? 0));
    return {
      id: `tier:${tier.priority}`,
      priority: tier.priority,
      items: tier.items.flatMap((item, itemIndex) =>
        toItem(item, { kind: 'tier', index, shareLabel: tier.items.length > 1 ? labels[itemIndex] : undefined }),
      ),
    };
  });
  const parking: WeightedTierParkingList<RoutingBoardItemView>[] = [
    {
      id: 'unused',
      label: m['dashboard.routing.editor.unused'](),
      heading: parkingHeading(m['dashboard.routing.editor.unused']()),
      items: board.unused.flatMap((item) => toItem(item, { kind: 'unused' })),
      droppable: true,
      testId: 'routing-list-unused',
    },
    ...(board.blocked.length === 0
      ? []
      : [
          {
            id: 'blocked',
            label: m['dashboard.routing.editor.blocked'](),
            heading: parkingHeading(m['dashboard.routing.editor.blocked']()),
            items: board.blocked.flatMap((item) => toItem(item, { kind: 'blocked' })),
            droppable: false,
            testId: 'routing-list-blocked',
          },
        ]),
  ];
  const previousLayout = routingBoardLayout(board);

  const moveOptions = (placement: Placement): RoutingBoardMoveOption[] => {
    if (placement.kind === 'blocked') return [];
    const current = placement.kind === 'tier' ? placement.index : undefined;
    return [
      ...board.tiers.flatMap((_, index) =>
        index === current
          ? []
          : [
              {
                label: m['dashboard.routing.detail.move_to_tier']({
                  tier: m['dashboard.routing.tier_label.short']({ value: index + 1 }),
                }),
                target: { type: 'tier', index } as const,
              },
            ],
      ),
      { label: m['dashboard.routing.detail.move_to_new_tier'](), target: { type: 'new-tier' } as const },
      ...(placement.kind === 'unused'
        ? []
        : [{ label: m['dashboard.routing.detail.move_to_unused'](), target: { type: 'unused' } as const }]),
    ];
  };

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{m['dashboard.routing.editor.board_help']()}</p>
      <WeightedTierBoard
        columns={<RoutingBoardColumns writable={writable} />}
        tiers={tiers}
        parking={parking}
        writable={writable}
        labels={{
          tier: (index, priority) => {
            const tier = board.tiers[index];
            return (
              <span className="flex w-full items-center gap-2.5">
                <RoutingTierLabel tier={index + 1} priority={priority} />
                <span className="truncate font-sans text-xs font-normal text-muted-foreground">
                  {index === 0
                    ? m['dashboard.routing.tier_label.primary']()
                    : m['dashboard.routing.tier_label.fallback']()}
                </span>
                {tier === undefined || tier.items.length < 2 ? null : (
                  <span aria-hidden="true" className="ml-auto flex h-1 w-32 gap-0.5">
                    {tier.items.map((item, itemIndex) => (
                      <span
                        key={item.providerId}
                        className={cn(
                          'min-w-0.5 basis-0 rounded-full',
                          SEGMENT_CLASSES[itemIndex % SEGMENT_CLASSES.length],
                        )}
                        style={{ flexGrow: item.share ?? 0 }}
                      />
                    ))}
                  </span>
                )}
              </span>
            );
          },
          dragTier: (index) => m['dashboard.providers.routing.drag_tier']({ tier: index + 1 }),
          newTier: m['dashboard.routing.editor.new_priority'](),
          emptyTier: m['dashboard.providers.routing.empty_tier'](),
        }}
        renderItem={({ provider, item, rowIndex, hasOverride, placement }) => (
          <RoutingBoardItem
            provider={provider}
            weight={item.weight}
            shareLabel={placement.kind === 'tier' ? placement.shareLabel : undefined}
            configuredShare={comparableShares.has(item.providerId) ? item.share : null}
            actual={actualByProviderId?.get(item.providerId)}
            selection={selection}
            parkedReason={
              placement.kind === 'unused'
                ? m['dashboard.routing.editor.disabled_for_model']()
                : placement.kind === 'blocked'
                  ? blockedReason(provider)
                  : undefined
            }
            hasOverride={hasOverride}
            writable={writable}
            moveOptions={moveOptions(placement)}
            onMove={(target) => move(provider.id, target)}
            onWeightChange={(weight) =>
              setRows(applyRoutingWeight({ providers: model.providers, rows, providerId: provider.id, weight }))
            }
            onReset={() => form.setFieldValue(`providers[${rowIndex}]`, { providerId: provider.id })}
          />
        )}
        onLayoutChange={(nextLayout, operation) =>
          setRows(
            applyRoutingBoardLayout({
              providers: model.providers,
              previousRows: rows,
              previousLayout,
              nextLayout,
              operation,
            }),
          )
        }
        testId="routing-board"
        tierTestId={(_index, id) => `routing-list-${id}`}
      />
    </div>
  );
};

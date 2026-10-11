import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider, RouterSelection } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@aio-proxy/ui/components/dropdown-menu';
import { cn } from '@aio-proxy/ui/lib/utils';
import { Ellipsis } from 'lucide-react';
import type React from 'react';

import { ProviderLabel } from '@/components/provider-label';
import { WeightField } from '@/components/weight-field';

import type { RoutingMoveTarget } from '../lib/routing-board';
import { ROUTING_BOARD_ROW_GRID } from '../lib/routing-board';
import { DEVIATION_THRESHOLD } from '../lib/routing-risk';
import type { RoutingTierShare } from '../lib/routing-traffic';
import { RoutingProviderIdentity } from './routing-provider-identity';

const percentFormatter = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const secondsFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export interface RoutingBoardMoveOption {
  readonly label: string;
  readonly target: RoutingMoveTarget;
}

interface RoutingBoardItemProps {
  readonly provider: DashboardRoutingProvider;
  readonly weight: number;
  /** The tier-local share label, for a Provider that shares its tier. */
  readonly shareLabel: string | undefined;
  /** The configured share, compared with `actual` to flag drift. `null` when not comparable. */
  readonly configuredShare: number | null;
  readonly actual: RoutingTierShare | undefined;
  readonly selection?: RouterSelection;
  /** Why a parked Provider takes no traffic; `undefined` for a Provider in a tier. */
  readonly parkedReason: string | undefined;
  readonly hasOverride: boolean;
  readonly writable: boolean;
  readonly moveOptions: readonly RoutingBoardMoveOption[];
  readonly onMove: (target: RoutingMoveTarget) => void;
  readonly onWeightChange: (weight: number) => void;
  readonly onReset: () => void;
}

/** One Provider as a row of the route: who it is, its weight and share, and how it performed. */
export const RoutingBoardItem: React.FC<RoutingBoardItemProps> = ({
  provider,
  weight,
  shareLabel,
  configuredShare,
  actual,
  selection = 'weighted',
  parkedReason,
  hasOverride,
  writable,
  moveOptions,
  onMove,
  onWeightChange,
  onReset,
}) => {
  const drift =
    selection === 'weighted' &&
    configuredShare !== null &&
    actual !== undefined &&
    actual.actualShare !== null &&
    Math.abs(actual.actualShare - configuredShare) >= DEVIATION_THRESHOLD;
  const dash = <span className="text-muted-foreground">—</span>;

  return (
    <div className={cn(ROUTING_BOARD_ROW_GRID, 'text-sm')} data-testid={`routing-row-${provider.id}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        <ProviderLabel providerId={provider.id}>
          {(view) => <RoutingProviderIdentity view={view} muted={parkedReason !== undefined} />}
        </ProviderLabel>
        {hasOverride ? (
          <span className="shrink-0 text-xs text-primary">{m['dashboard.routing.route.override']()}</span>
        ) : null}
      </div>
      {parkedReason === undefined ? (
        <>
          <WeightField
            weight={weight}
            min={1}
            disabled={!writable}
            aria-label={m['dashboard.routing.detail.weight_label']({ providerId: provider.id })}
            data-testid={`routing-weight-${provider.id}`}
            onWeightChange={onWeightChange}
          />
          <span className="text-right font-mono text-xs tabular-nums" data-testid={`routing-share-${provider.id}`}>
            {shareLabel ?? dash}
          </span>
          <span className={cn('text-right font-mono text-xs tabular-nums', drift && 'text-destructive')}>
            {configuredShare === null || actual?.actualShare == null
              ? dash
              : percentFormatter.format(actual.actualShare)}
          </span>
        </>
      ) : (
        <span className="col-span-3 text-right text-xs text-muted-foreground">{parkedReason}</span>
      )}
      <span className="text-right font-mono text-xs tabular-nums">
        {actual?.successRate == null ? dash : percentFormatter.format(actual.successRate)}
      </span>
      <span className="text-right font-mono text-xs tabular-nums">
        {actual?.p95LatencyMs == null ? dash : `${secondsFormatter.format(actual.p95LatencyMs / 1000)}s`}
      </span>
      {writable && (moveOptions.length > 0 || hasOverride) ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={m['dashboard.routing.detail.row_actions']({ providerId: provider.id })}
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {moveOptions.map((option) => (
              <DropdownMenuItem key={option.label} onClick={() => onMove(option.target)}>
                {option.label}
              </DropdownMenuItem>
            ))}
            {hasOverride ? (
              <>
                {moveOptions.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem data-testid={`routing-reset-${provider.id}`} onClick={onReset}>
                  {m['dashboard.routing.detail.reset_default']()}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span />
      )}
    </div>
  );
};

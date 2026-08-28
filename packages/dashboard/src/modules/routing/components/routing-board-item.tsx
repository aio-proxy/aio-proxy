import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Slider } from '@aio-proxy/ui/components/slider';
import { useDraggable } from '@dnd-kit/react';
import { GripVertical } from 'lucide-react';

import type { useRoutingForm } from '../hooks/use-routing-form';
import { formatRoutingShareValue } from '../lib/routing-summary';

interface RoutingBoardItemProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly provider: DashboardRoutingProvider;
  readonly index: number;
  readonly share: number | null;
  readonly weight: number;
  readonly unused: boolean;
  readonly writable: boolean;
  readonly draggable: boolean;
  readonly hasOverride: boolean;
  readonly shareMax?: number;
  readonly sliderMax?: number;
  readonly onShareChange?: (weight: number) => void;
}

export const RoutingBoardItem: React.FC<RoutingBoardItemProps> = ({
  form,
  provider,
  index,
  share,
  weight,
  unused,
  writable,
  draggable,
  hasOverride,
  shareMax,
  sliderMax,
  onShareChange,
}) => {
  const { ref, handleRef, isDragging } = useDraggable({
    id: provider.id,
    type: 'provider',
    disabled: !writable || !draggable,
  });
  const stateLabel =
    provider.state.status === 'unavailable'
      ? m['dashboard.routing.editor.provider_unavailable']()
      : m['dashboard.routing.editor.provider_ready']();
  const showShareControl =
    writable &&
    !unused &&
    onShareChange !== undefined &&
    share !== null &&
    shareMax !== undefined &&
    sliderMax !== undefined;
  const shareLabel = share === null ? null : formatRoutingShareValue(share);

  return (
    <div
      ref={ref}
      data-testid={`routing-provider-${provider.id}`}
      data-dragging={isDragging || undefined}
      className="space-y-2 rounded-lg bg-background px-3 py-2"
    >
      <div className="flex items-center gap-3">
        {writable && draggable ? (
          <span ref={handleRef} className="inline-flex">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="cursor-grab active:cursor-grabbing"
              aria-label={m['dashboard.routing.editor.drag_handle']()}
            >
              <GripVertical />
            </Button>
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          {provider.name === undefined ? null : <div className="font-medium">{provider.name}</div>}
          <div className="font-mono text-xs text-muted-foreground">{provider.id}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Badge variant="outline">{stateLabel}</Badge>
          {provider.enabled ? null : (
            <Badge variant="secondary">{m['dashboard.routing.editor.provider_disabled']()}</Badge>
          )}
          {weight === 0 ? (
            <Badge data-testid={`routing-disabled-${provider.id}`} variant="outline">
              {m['dashboard.routing.editor.disabled_for_model']()}
            </Badge>
          ) : null}
          {shareLabel === null ? null : (
            <span className="text-sm text-muted-foreground" data-testid={`routing-share-${provider.id}`}>
              {m['dashboard.routing.editor.share']({ value: shareLabel })}
            </span>
          )}
          {writable && hasOverride ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`routing-reset-${provider.id}`}
              onClick={() => form.setFieldValue(`providers[${index}]`, { providerId: provider.id })}
            >
              {m['dashboard.routing.editor.reset']()}
            </Button>
          ) : null}
        </div>
      </div>
      {showShareControl ? (
        <Slider
          aria-label={m['dashboard.routing.editor.share_control']()}
          data-testid={`routing-share-slider-${provider.id}`}
          min={0}
          max={sliderMax}
          thumbAlignment="center"
          value={[weight]}
          disabled={shareMax <= 1}
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next !== 'number') return;
            onShareChange?.(Math.min(shareMax, Math.max(1, next)));
          }}
        />
      ) : null}
    </div>
  );
};

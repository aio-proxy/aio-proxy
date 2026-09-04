import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Slider } from '@aio-proxy/ui/components/slider';
import { cn } from '@aio-proxy/ui/lib/utils';
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable';
import { useSortable } from '@dnd-kit/react/sortable';
import { GripVertical } from 'lucide-react';
import type React from 'react';

import { providerDisplayName } from '../../lib/provider-list-view';

const SORTABLE_PLUGINS = [SortableKeyboardPlugin];

interface ProviderRoutingCardProps {
  readonly provider: DashboardProviderSummary;
  readonly tierListId: string;
  readonly index: number;
  readonly share: number;
  readonly canAdjustShare: boolean;
  readonly onShareChange: (share: number) => void;
}

export const ProviderRoutingCard: React.FC<ProviderRoutingCardProps> = ({
  provider,
  tierListId,
  index,
  share,
  canAdjustShare,
  onShareChange,
}) => {
  const { ref, handleRef, isDragging } = useSortable({
    id: provider.id,
    index,
    group: tierListId,
    type: 'provider',
    accept: 'provider',
    plugins: SORTABLE_PLUGINS,
  });
  const stateLabel =
    provider.state.status === 'unavailable'
      ? m['dashboard.routing.editor.provider_unavailable']()
      : m['dashboard.routing.editor.provider_ready']();

  return (
    <div
      ref={ref}
      className={cn('space-y-2 rounded-lg bg-background px-3 py-2', isDragging && 'opacity-70')}
      data-testid={`provider-routing-item-${provider.id}`}
      data-dragging={isDragging || undefined}
    >
      <div className="flex items-center gap-3">
        <Button
          ref={handleRef}
          type="button"
          size="icon-sm"
          variant="ghost"
          className="cursor-grab text-muted-foreground active:cursor-grabbing"
          aria-label={m['dashboard.providers.routing.drag_provider']({ providerId: provider.id })}
        >
          <GripVertical />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{providerDisplayName(provider)}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Badge variant="outline">{stateLabel}</Badge>
          {provider.enabled ? null : (
            <Badge variant="secondary">{m['dashboard.routing.editor.provider_disabled']()}</Badge>
          )}
          <span className="text-sm text-muted-foreground" data-testid={`provider-share-${provider.id}`}>
            {share}%
          </span>
        </div>
      </div>
      {canAdjustShare ? (
        <Slider
          aria-label={m['dashboard.providers.routing.share_aria']({ providerId: provider.id })}
          data-testid={`provider-share-slider-${provider.id}`}
          min={1}
          max={100}
          step={1}
          value={[share]}
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next === 'number') onShareChange(next);
          }}
        />
      ) : null}
    </div>
  );
};

import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable';
import { useSortable } from '@dnd-kit/react/sortable';
import { GripVertical } from 'lucide-react';
import type React from 'react';

import type { ProviderHealth } from '../../services/provider-health-service';
import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderCard } from '../provider-card';

const SORTABLE_PLUGINS = [SortableKeyboardPlugin];

interface ProviderRoutingCardProps {
  readonly provider: DashboardProviderSummary;
  readonly tierListId: string;
  readonly index: number;
  readonly share: number;
  readonly editing: boolean;
  readonly health: ProviderHealth | undefined;
  readonly usage: ProviderUsage | undefined;
  readonly usagePending: boolean;
  readonly pluginLabel: string | undefined;
  readonly pluginIcon: string | undefined;
  readonly focused: boolean;
  readonly canAdjustShare: boolean;
  readonly onShareChange: (share: number) => void;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderRoutingCard: React.FC<ProviderRoutingCardProps> = ({
  provider,
  tierListId,
  index,
  share,
  editing,
  health,
  usage,
  usagePending,
  pluginLabel,
  pluginIcon,
  focused,
  canAdjustShare,
  onShareChange,
  onDelete,
}) => {
  const { ref, handleRef, isDragging } = useSortable({
    id: provider.id,
    index,
    group: tierListId,
    type: 'provider',
    accept: 'provider',
    disabled: !editing,
    plugins: SORTABLE_PLUGINS,
  });

  return (
    <div ref={editing ? ref : undefined} className={cn('min-w-0', isDragging && 'z-20 opacity-70')}>
      <ProviderCard
        provider={provider}
        health={health}
        usage={usage}
        usagePending={usagePending}
        pluginLabel={pluginLabel}
        pluginIcon={pluginIcon}
        focused={focused}
        onDelete={onDelete}
        routing={{
          editing,
          share,
          canAdjustShare,
          onShareChange,
          dragHandle: editing ? (
            <Button
              ref={handleRef}
              type="button"
              size="icon-xs"
              variant="ghost"
              className="relative z-20 cursor-grab text-muted-foreground active:cursor-grabbing"
              aria-label={m['dashboard.providers.routing.drag_provider']({ providerId: provider.id })}
            >
              <GripVertical />
            </Button>
          ) : undefined,
        }}
      />
    </div>
  );
};

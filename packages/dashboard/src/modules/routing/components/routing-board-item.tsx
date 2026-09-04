import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';

import type { useRoutingForm } from '../hooks/use-routing-form';

interface RoutingBoardItemProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly provider: DashboardRoutingProvider;
  readonly index: number;
  readonly weight: number;
  readonly writable: boolean;
  readonly hasOverride: boolean;
}

export const RoutingBoardItem: React.FC<RoutingBoardItemProps> = ({
  form,
  provider,
  index,
  weight,
  writable,
  hasOverride,
}) => {
  const stateLabel =
    provider.state.status === 'unavailable'
      ? m['dashboard.routing.editor.provider_unavailable']()
      : m['dashboard.routing.editor.provider_ready']();

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {provider.name === undefined ? null : <div className="truncate font-medium">{provider.name}</div>}
        <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
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
  );
};

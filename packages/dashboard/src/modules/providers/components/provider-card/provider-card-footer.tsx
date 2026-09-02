import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { CardFooter } from '@aio-proxy/ui/components/card';
import type React from 'react';

import { formatCompactTokenCount } from '@/components/token-count';

import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderEnabledSwitch } from '../provider-enabled-switch';
import { ProviderMoreMenu } from '../provider-more-menu';

interface ProviderCardFooterProps {
  readonly provider: DashboardProviderSummary;
  readonly usage: ProviderUsage | undefined;
  readonly usagePending: boolean;
  readonly editable: boolean;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

const requestCountLabel = (usage: ProviderUsage | undefined, usagePending: boolean): string => {
  if (usagePending) return '…';
  return usage === undefined ? 'N/A' : formatCompactTokenCount(usage.requestCount);
};

export const ProviderCardFooter: React.FC<ProviderCardFooterProps> = ({
  provider,
  usage,
  usagePending,
  editable,
  onDelete,
}) => (
  <CardFooter className="justify-between gap-2">
    <div className="truncate text-xs text-muted-foreground">
      {`${m['dashboard.providers.card.models_count']({ count: provider.clientModels.length })} · ${m['dashboard.providers.card.requests_24h']({ count: requestCountLabel(usage, usagePending) })}`}
    </div>
    {/* Above the identity link's full-card `::after` overlay, so these stay clickable. */}
    <div className="relative z-10 flex shrink-0 items-center gap-1">
      {editable ? (
        <>
          <ProviderEnabledSwitch provider={provider} />
          <ProviderMoreMenu provider={provider} onDelete={onDelete} />
        </>
      ) : (
        // A Provider the editor cannot represent must offer neither a toggle nor an edit entry —
        // both would act on a config the dashboard failed to parse. Deletion is all that is left.
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-testid="provider-card-delete"
          onClick={() => onDelete(provider)}
        >
          {m['dashboard.providers.actions.delete']()}
        </Button>
      )}
    </div>
  </CardFooter>
);

import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { CardFooter } from '@aio-proxy/ui/components/card';
import type React from 'react';

import { ProviderEnabledSwitch } from '../provider-enabled-switch';
import { ProviderMoreMenu } from '../provider-more-menu';
import { ProviderModelCount } from './provider-model-count';

interface ProviderCardFooterProps {
  readonly provider: DashboardProviderSummary;
  readonly editable: boolean;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderCardFooter: React.FC<ProviderCardFooterProps> = ({ provider, editable, onDelete }) => (
  <CardFooter className="mt-auto justify-between gap-2">
    <div className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
      <ProviderModelCount models={provider.clientModels} />
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

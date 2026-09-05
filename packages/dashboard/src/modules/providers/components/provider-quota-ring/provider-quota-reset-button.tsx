import { m } from '@aio-proxy/i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@aio-proxy/ui/components/alert-dialog';
import { Button } from '@aio-proxy/ui/components/button';
import { TicketCheck } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';

import { useProviderQuotaReset } from '../../hooks/use-provider-quota-reset';

interface ProviderQuotaResetButtonProps {
  readonly providerId: string;
  readonly availableCount: number;
}

/**
 * Redemption is irreversible and spends a scarce grant, so it is confirmed rather than one-click. The
 * confirmation is owned here: nothing outside this button reacts to it opening, cancelling, or
 * completing, and the quota reading it invalidates is refetched by the shared query.
 */
export const ProviderQuotaResetButton: React.FC<ProviderQuotaResetButtonProps> = ({ providerId, availableCount }) => {
  const [confirming, setConfirming] = useState(false);
  const reset = useProviderQuotaReset(providerId);

  return (
    <>
      {/* `focusableWhenDisabled` because the button disables itself while the request is in flight:
          inside the focus-trapped quota modal that would otherwise drop a keyboard user's focus. */}
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="provider-quota-reset"
        disabled={reset.isPending}
        focusableWhenDisabled
        onClick={() => setConfirming(true)}
      >
        <TicketCheck data-icon="inline-start" />
        {m['dashboard.providers.quota.reset']()}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="provider-quota-reset-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{m['dashboard.providers.quota.reset_confirm_title']()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m['dashboard.providers.quota.reset_confirm_description']({ id: providerId, count: availableCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m['dashboard.providers.quota.reset_confirm_cancel']()}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="provider-quota-reset-confirm"
              disabled={reset.isPending}
              onClick={() => {
                reset.mutate();
                setConfirming(false);
              }}
            >
              {m['dashboard.providers.quota.reset_confirm_action']()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

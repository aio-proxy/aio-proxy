import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Loader2, TicketCheck } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { useProviderQuotaReset } from '../../hooks/use-provider-quota-reset';

interface ProviderQuotaResetButtonProps {
  readonly providerId: string;
  readonly availableCount: number;
}

/**
 * Redemption is irreversible and spends a scarce grant, so it is confirmed rather than one-click. The
 * confirmation is inline rather than an `AlertDialog` because this button already lives inside the quota
 * modal: a second popup covers the reading the decision is being made from, and the two stacked frames
 * read as one broken frame. The confirmation is owned here — nothing outside this button reacts to it
 * opening, cancelling, or completing, and the quota reading it invalidates is refetched by the shared
 * query.
 */
export const ProviderQuotaResetButton: React.FC<ProviderQuotaResetButtonProps> = ({ providerId, availableCount }) => {
  const [confirming, setConfirming] = useState(false);
  const descriptionId = useId();
  // Set when this component is the one that started the redemption, and cleared once focus has been
  // handed back to the returning trigger. Confirming unmounts the button the keyboard user activated, so
  // without this focus would sit on the document body for the seconds the request and its refetch take.
  // Gating on it matters: a remount while somebody else's redemption is still in flight — reopening the
  // popup — must not yank focus out of wherever the user actually is. A ref rather than state because
  // nothing renders from it; the effect below is the only reader.
  const claimedRef = useRef(false);
  const slotRef = useRef<HTMLButtonElement | null>(null);
  const reset = useProviderQuotaReset(providerId);

  useEffect(() => {
    if (!claimedRef.current) return;
    // React does not reuse the node across the swap, so focus has to be moved on each mount: onto the
    // progress control when the request starts, then back onto the trigger when it settles.
    slotRef.current?.focus();
    if (!reset.isPending) claimedRef.current = false;
  }, [confirming, reset.isPending]);

  // In flight wins over the confirmation: the request is already irrevocable, so re-offering the choice
  // would be a lie, and the same slot has to carry the progress the user is waiting on.
  if (reset.isPending) {
    return (
      // A focusable disabled button rather than a plain span: focus is parked here for the whole wait, and
      // only a control that stays in the tab order can hold it. `disabled` alone reads as inert, which is
      // what the spinner and its label are here to contradict.
      <Button
        ref={slotRef}
        type="button"
        size="sm"
        variant="outline"
        disabled
        focusableWhenDisabled
        data-testid="provider-quota-reset-pending"
      >
        <Loader2 data-icon="inline-start" className="animate-spin" />
        {m['dashboard.providers.quota.reset_pending']()}
      </Button>
    );
  }

  if (confirming) {
    return (
      // `w-full` so the confirmation takes its own line in the wrapping row rather than squeezing the
      // count it qualifies; `order-last` keeps it below that count on a narrow popup.
      <div
        data-testid="provider-quota-reset-confirm-inline"
        className="order-last w-full space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2"
      >
        <p id={descriptionId} className="text-xs">
          {m['dashboard.providers.quota.reset_confirm_description']({ count: availableCount })}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {/* The trigger is unmounted to make room for this, so a keyboard user's focus would otherwise
              fall back to the modal itself and lose the prompt. Cancel rather than the action: the
              redemption is irreversible, so a stray Return must not spend the credit.

              Both buttons are described by the paragraph. Without an enclosing dialog nothing would
              announce the count and the irreversibility on its own, so the consequence has to travel
              with whichever control is focused — the way `AlertDialogDescription` used to supply it. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            autoFocus
            aria-describedby={descriptionId}
            onClick={() => setConfirming(false)}
          >
            {m['dashboard.providers.quota.reset_confirm_cancel']()}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="provider-quota-reset-confirm"
            aria-describedby={descriptionId}
            onClick={() => {
              claimedRef.current = true;
              reset.mutate();
              setConfirming(false);
            }}
          >
            {m['dashboard.providers.quota.reset_confirm_action']()}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Button
      ref={slotRef}
      type="button"
      size="sm"
      variant="outline"
      data-testid="provider-quota-reset"
      onClick={() => setConfirming(true)}
    >
      <TicketCheck data-icon="inline-start" />
      {m['dashboard.providers.quota.reset']()}
    </Button>
  );
};

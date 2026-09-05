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
  // Set when leaving the confirmation, cleared once focus has been handed back. Confirming replaces the
  // trigger with a `div`, so React cannot reuse the node and the control the keyboard user activated is
  // unmounted — whether they confirm or cancel, focus would otherwise drop to the document body. The
  // trigger and the progress control are the same `<Button ref={slotRef}>` position, so React does reuse
  // that node across the in-flight swap and one hand-off carries the whole wait.
  //
  // A ref rather than state because nothing renders from it; the effect below is the only reader. Gating
  // on it is what keeps a remount during somebody else's in-flight redemption — the popup being
  // reopened — from yanking focus out of wherever the user actually is.
  const owesFocusRef = useRef(false);
  const slotRef = useRef<HTMLButtonElement | null>(null);
  const reset = useProviderQuotaReset(providerId);

  useEffect(() => {
    if (!owesFocusRef.current) return;
    owesFocusRef.current = false;
    slotRef.current?.focus();
  }, [confirming]);

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
            data-testid="provider-quota-reset-cancel"
            aria-describedby={descriptionId}
            onClick={() => {
              owesFocusRef.current = true;
              setConfirming(false);
            }}
          >
            {m['dashboard.providers.quota.reset_confirm_cancel']()}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="provider-quota-reset-confirm"
            aria-describedby={descriptionId}
            onClick={() => {
              owesFocusRef.current = true;
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

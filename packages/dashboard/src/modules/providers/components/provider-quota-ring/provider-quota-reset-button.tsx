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
 *
 * Whether there is anything to redeem is decided here too, rather than by the caller. The redemption
 * outlives the count it was started from: the refetch publishes `availableCount: 0` while the request is
 * still in flight, so a caller-side gate would unmount the spinner mid-request and reproduce the dead
 * click this control exists to remove.
 */
export const ProviderQuotaResetButton: React.FC<ProviderQuotaResetButtonProps> = ({ providerId, availableCount }) => {
  const [confirming, setConfirming] = useState(false);
  const descriptionId = useId();
  // The control the user activated is unmounted by every step of a redemption: confirming replaces the
  // trigger with a `div`, cancelling and confirming replace that `div` back, and spending the last credit
  // removes the whole thing. Each of those leaves focus on the document body, outside the popup the user
  // is still reading, so an orphaned focus is handed back below.
  //
  // `slotRef` is the control to hand it to. The trigger and the progress button are the same
  // `<Button ref={slotRef}>` position, so React reuses that node across the in-flight swap and focus
  // survives it untouched; only the confirmation and the exhausted case need the hand-off.
  const slotRef = useRef<HTMLButtonElement | null>(null);
  // The confirmation is the other thing that can hold focus, and it is a different element, so it needs
  // its own handle for the containment check below.
  const confirmRef = useRef<HTMLDivElement | null>(null);
  // Where focus goes when the redemption spent the last credit and there is no slot left. Remembered
  // while a slot is still mounted, since by then there is no node to look upwards from.
  const fallbackRef = useRef<HTMLElement | null>(null);
  // Whether the focus that went missing was ours to hand back. A popup reopened while somebody else's
  // redemption is in flight must not pull focus out of wherever the user actually is.
  const heldFocusRef = useRef(false);

  const reset = useProviderQuotaReset(providerId);
  // In flight outranks the count: the request is already irrevocable, so the progress has to stay on
  // screen even after the refetch it triggers publishes a zero count. A confirmation does not get the
  // same treatment — nothing has been spent yet, and Refresh stays reachable while the prompt is open,
  // so a count that reached zero elsewhere must retract the offer rather than let it submit into the
  // server's zero-inventory preflight.
  const offersRedemption = availableCount > 0 || reset.isPending;

  // Not merely hidden: a later refresh that finds a new credit would otherwise spring the prompt back
  // open on a decision the user never made twice. Adjusted during render rather than in an effect so
  // the retracted prompt is never committed — React re-runs this component before touching the DOM.
  if (confirming && availableCount === 0) setConfirming(false);

  // Deliberately unkeyed: it has to observe the render that dropped the focused node, whichever one
  // that was. Reads refs only here, never during render.
  useEffect(() => {
    const slot = slotRef.current;
    if (heldFocusRef.current && document.activeElement === document.body) {
      (slot ?? fallbackRef.current)?.focus();
    }
    // Recorded after the hand-off so the next render knows whether focus is still ours to return.
    // Containment rather than "not the body": a redemption somebody else started leaves focus wherever
    // the user is, and that is not a claim on it. `autoFocus` on the confirmation's Cancel button has
    // already run by now, which is what keeps the claim alive across the swap that unmounts the trigger.
    const host = slot ?? confirmRef.current;
    heldFocusRef.current = host !== null && host.contains(document.activeElement);
    if (slot !== null) fallbackRef.current = slot.closest<HTMLElement>('[role="dialog"]');
  });

  if (!offersRedemption) return null;

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
        ref={confirmRef}
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

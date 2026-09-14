import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useCallback, useEffect, useRef } from 'react';

import { useDetachSync, useCancelDetachSync } from '@/hooks/use-sync';

/**
 * Detaching a shared OAuth Provider takes two calls with a fresh authorization between them. The
 * first marks the Provider `detach-pending`, which is what stops the login that follows from being
 * published as the shared credential; the second names that login's session as the proof the
 * candidate is independent. Only this hook knows a login was started for a detachment, so an
 * unrelated re-authorization never completes one.
 */
export const useProviderDetach = (providerId: string | undefined) => {
  const { mutate, mutateAsync } = useDetachSync();
  const { mutate: cancelDetach } = useCancelDetachSync();
  // The Provider whose detachment is waiting for a login, not merely that one is. The editor keeps
  // this hook across a route change, so an intent started for one Provider must never be completed
  // or cancelled against whichever Provider happens to be displayed when the login settles.
  const awaitingLogin = useRef<string | undefined>(undefined);

  // `detach-pending` is server state, and it blocks every read of the shared credential while it
  // stands. An authorization that never started or never finished leaves nothing to approve, so
  // dropping the local intent is not enough — the Provider would stay blocked until the user
  // retried or reached for the CLI. Cancelling restores the row to `shared`.
  const release = useCallback(
    (target: string) => {
      awaitingLogin.current = undefined;
      cancelDetach(
        { providerId: target },
        {
          onError: () => toast.add({ type: 'error', title: m['dashboard.sync.detach_cancel_failed']() }),
        },
      );
    },
    [cancelDetach],
  );

  const start = useCallback(
    async (startLogin: () => boolean) => {
      if (providerId === undefined) return;
      await mutateAsync({ providerId });
      // Only a login that actually began can carry the proof. A save the editor refused — an invalid
      // field, a blocking section — starts none, and recording the intent anyway would let the next
      // unrelated re-authorization complete a detachment nobody asked for. Thrown rather than
      // swallowed so the control that asked for it reports the failure where the user clicked.
      if (!startLogin()) {
        release(providerId);
        throw new Error('DETACH_LOGIN_NOT_STARTED');
      }
      awaitingLogin.current = providerId;
    },
    [mutateAsync, providerId, release],
  );

  // A login that failed or was cancelled brings no proof either, and the intent must not outlive it.
  // Guarded, so a lost login this hook never asked for does not cancel someone else's detachment.
  const cancel = useCallback(() => {
    const target = awaitingLogin.current;
    if (target !== undefined) release(target);
  }, [release]);

  // Navigating to another Provider, or away from the editor, abandons the login this intent is
  // waiting for: nothing left on screen can ever complete it, so the row has to come back here.
  useEffect(() => () => cancel(), [cancel, providerId]);

  const complete = useCallback(
    (loginSessionId: string) => {
      if (providerId === undefined || awaitingLogin.current !== providerId) return;
      awaitingLogin.current = undefined;
      // Reported here because this call outlives the click that began it: the button's own error
      // line is gone by the time the login lands.
      mutate(
        { providerId, loginSessionId },
        { onError: () => toast.add({ type: 'error', title: m['dashboard.sync.detach_failed']() }) },
      );
    },
    [mutate, providerId],
  );

  return { start, complete, cancel };
};

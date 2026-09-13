import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useCallback, useRef } from 'react';

import { useDetachSync } from '@/hooks/use-sync';

/**
 * Detaching a shared OAuth Provider takes two calls with a fresh authorization between them. The
 * first marks the Provider `detach-pending`, which is what stops the login that follows from being
 * published as the shared credential; the second names that login's session as the proof the
 * candidate is independent. Only this hook knows a login was started for a detachment, so an
 * unrelated re-authorization never completes one.
 */
export const useProviderDetach = (providerId: string | undefined) => {
  const { mutate, mutateAsync } = useDetachSync();
  const awaitingLogin = useRef(false);

  const start = useCallback(
    async (startLogin: () => boolean) => {
      if (providerId === undefined) return;
      await mutateAsync({ providerId });
      // Only a login that actually began can carry the proof. A save the editor refused — an invalid
      // field, a blocking section — starts none, and recording the intent anyway would let the next
      // unrelated re-authorization complete a detachment nobody asked for. Thrown rather than
      // swallowed so the control that asked for it reports the failure where the user clicked.
      if (!startLogin()) throw new Error('DETACH_LOGIN_NOT_STARTED');
      awaitingLogin.current = true;
    },
    [mutateAsync, providerId],
  );

  // A login that failed or was cancelled brings no proof either, and the intent must not outlive it.
  const cancel = useCallback(() => {
    awaitingLogin.current = false;
  }, []);

  const complete = useCallback(
    (loginSessionId: string) => {
      if (!awaitingLogin.current || providerId === undefined) return;
      awaitingLogin.current = false;
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

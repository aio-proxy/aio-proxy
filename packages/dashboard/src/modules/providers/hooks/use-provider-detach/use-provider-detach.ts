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
    async (startLogin: () => void) => {
      if (providerId === undefined) return;
      await mutateAsync({ providerId });
      awaitingLogin.current = true;
      startLogin();
    },
    [mutateAsync, providerId],
  );

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

  return { start, complete };
};

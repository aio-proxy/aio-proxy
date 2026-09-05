import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';

import { celebrate, type CelebrationOrigin } from '@/lib/celebrate';
import { queryKeys } from '@/lib/query-keys';

import {
  DashboardProviderQuotaResetError,
  QUOTA_RESET_UNAVAILABLE_STATUS,
  resetProviderQuota,
} from '../../services/provider-quota-reset-service';

/**
 * Refetches rather than seeds: the redemption returns no snapshot, and the server has already dropped
 * the cached one so the refetch reads the post-reset inventory upstream. Refetched on failure too — a
 * 409 means the credit this button was rendered from is gone, and the stale count must not survive it.
 *
 * `mutate` requires the point to celebrate from, so the burst lands on the control the user actually
 * pressed. It is a resolved point rather than the element, and it is supplied at call time rather than
 * read at success time, because the confirmation button is unmounted the moment it is pressed — by
 * `onSuccess` there is nothing left to measure, and a detached node reports a zero rect in the
 * viewport corner.
 */
export const useProviderQuotaReset = (id: string) => {
  const client = useQueryClient();
  // Keyed so the pending state can be read from the mutation cache below.
  const mutationKey = queryKeys.providerQuotaReset(id);
  const mutation = useMutation({
    mutationKey,
    mutationFn: (_origin: CelebrationOrigin) => resetProviderQuota(id),
    // Returned, not discarded: react-query holds the mutation pending until this settles, which keeps
    // the button disabled across the refetch. Discarding it ends the pending state while the pre-reset
    // count is still rendered, and with several credits the user can confirm a second redemption
    // against it — the server's own preflight would still see a remaining credit and spend it.
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.providerQuota(id) }),
    onSuccess: (_data, origin) => {
      toast.add({ type: 'success', title: m['dashboard.providers.quota.reset_succeeded']() });
      // A reset credit is scarce and spending one is irreversible, so the outcome gets more than a
      // corner toast the user has to go looking for.
      celebrate(origin);
    },
    onError: (error: unknown) => {
      const unavailable =
        error instanceof DashboardProviderQuotaResetError && error.status === QUOTA_RESET_UNAVAILABLE_STATUS;
      toast.add({
        type: 'error',
        title: unavailable
          ? m['dashboard.providers.quota.reset_unavailable']()
          : m['dashboard.providers.quota.reset_failed'](),
      });
    },
  });

  return {
    ...mutation,
    // Overridden with the cache's answer rather than this observer's: the only caller lives inside the
    // quota popup, and closing it unmounts the observer. A fresh one reports idle even though the request
    // is still running, which — against the cached nonzero count — offers a second confirmation and
    // spends a second credit through the server's FIFO. The mutation outlives the popup; the observer
    // does not, so the cache is the only honest source.
    isPending: useIsMutating({ mutationKey }) > 0,
  };
};

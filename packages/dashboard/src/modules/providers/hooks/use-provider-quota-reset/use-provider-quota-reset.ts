import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';

import { celebrate } from '@/lib/celebrate';
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
 * `originRef` is where the celebration is fired from — the control that was activated, so the burst
 * lands on the click rather than in the middle of a page the user is not looking at. Optional: the
 * redemption is reported by its toast either way.
 */
export const useProviderQuotaReset = (id: string, originRef?: RefObject<Element | null>) => {
  const client = useQueryClient();
  // Keyed so the pending state can be read from the mutation cache below.
  const mutationKey = queryKeys.providerQuotaReset(id);
  const mutation = useMutation({
    mutationKey,
    mutationFn: () => resetProviderQuota(id),
    // Returned, not discarded: react-query holds the mutation pending until this settles, which keeps
    // the button disabled across the refetch. Discarding it ends the pending state while the pre-reset
    // count is still rendered, and with several credits the user can confirm a second redemption
    // against it — the server's own preflight would still see a remaining credit and spend it.
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.providerQuota(id) }),
    onSuccess: () => {
      toast.add({ type: 'success', title: m['dashboard.providers.quota.reset_succeeded']() });
      // A reset credit is scarce and spending one is irreversible, so the outcome gets more than a
      // corner toast the user has to go looking for.
      celebrate(originRef?.current);
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

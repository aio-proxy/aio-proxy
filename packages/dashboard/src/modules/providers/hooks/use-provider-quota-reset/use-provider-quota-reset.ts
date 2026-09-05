import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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
 */
export const useProviderQuotaReset = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => resetProviderQuota(id),
    // Returned, not discarded: react-query holds the mutation pending until this settles, which keeps
    // the button disabled across the refetch. Discarding it ends the pending state while the pre-reset
    // count is still rendered, and with several credits the user can confirm a second redemption
    // against it — the server's own preflight would still see a remaining credit and spend it.
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.providerQuota(id) }),
    onSuccess: () => {
      toast.add({ type: 'success', title: m['dashboard.providers.quota.reset_succeeded']() });
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
};

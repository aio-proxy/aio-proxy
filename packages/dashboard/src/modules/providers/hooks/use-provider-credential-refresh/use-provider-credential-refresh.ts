import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { refreshProviderCredential } from '../../services/provider-credential-refresh-service';

/**
 * Invalidates the Provider list rather than seeding it: the refreshed `accountLabel` and `expiresAt`
 * only exist in the rebuilt server-side summary, and the refresh response carries no summary at all.
 */
export const useProviderCredentialRefresh = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => refreshProviderCredential(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      toast.add({ type: 'success', title: m['dashboard.providers.toast.credential_refreshed']() });
    },
    onError: () => {
      toast.add({ type: 'error', title: m['dashboard.providers.toast.credential_refresh_failed']() });
    },
  });
};

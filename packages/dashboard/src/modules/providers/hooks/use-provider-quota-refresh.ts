import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { getProviderQuota, type ProviderQuotaResult } from '../services/provider-quota-service';

/**
 * Bypasses the server's per-provider cooldown and seeds the shared cache entry, so the ring and any
 * open dialog both re-render from one reading.
 */
export const useProviderQuotaRefresh = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getProviderQuota(id, true),
    onSuccess: (result: ProviderQuotaResult) => {
      client.setQueryData(queryKeys.providerQuota(id), result);
    },
  });
};

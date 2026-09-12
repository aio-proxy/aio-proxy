import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import {
  applySync,
  disconnectSync,
  detachSync,
  previewSync,
  retrySync,
  setSyncRange,
  syncBackendsQueryOptions,
  syncQueryOptions,
} from '@/modules/settings/services/sync-service';

export const useSyncStatus = () => useQuery(syncQueryOptions());
export const useSyncBackends = () => useQuery(syncBackendsQueryOptions());

const invalidateSync = async (queryClient: ReturnType<typeof useQueryClient>) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.sync }),
    queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
    queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  ]);
};

const useSyncMutation = <Input, Output>(mutationFn: (input: Input) => Promise<Output>) => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => invalidateSync(queryClient) });
};

export const usePreviewSync = () => useSyncMutation(previewSync);
export const useApplySync = () => useSyncMutation(applySync);
export const useSetSyncRange = () => useSyncMutation(setSyncRange);
export const useDetachSync = () => useSyncMutation(detachSync);
export const useRetrySync = () => useSyncMutation(retrySync);
export const useDisconnectSync = () => useSyncMutation(disconnectSync);

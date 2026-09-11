import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import {
  applySync,
  cancelSyncDetach,
  disconnectSync,
  detachSync,
  previewSync,
  retrySync,
  setSyncRange,
  syncBackendsQueryOptions,
  syncQueryOptions,
} from '../../services/sync-service';

export const useSyncStatus = () => useQuery(syncQueryOptions());
export const useSyncBackends = () => useQuery(syncBackendsQueryOptions());

const invalidateSync = async (queryClient: ReturnType<typeof useQueryClient>) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.sync }),
    queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
    queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  ]);
};

export const usePreviewSync = () => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: previewSync, onSuccess: () => invalidateSync(queryClient) });
};

export const useApplySync = () => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: applySync, onSuccess: () => invalidateSync(queryClient) });
};

export const useSetSyncRange = () => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: setSyncRange, onSuccess: () => invalidateSync(queryClient) });
};

export const useDetachSync = () => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: detachSync, onSuccess: () => invalidateSync(queryClient) });
};

export const useCancelSyncDetach = () => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: cancelSyncDetach, onSuccess: () => invalidateSync(queryClient) });
};

export const useRetrySync = () => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: retrySync, onSuccess: () => invalidateSync(queryClient) });
};

export const useDisconnectSync = () => {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: disconnectSync, onSuccess: () => invalidateSync(queryClient) });
};

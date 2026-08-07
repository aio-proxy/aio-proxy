import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import {
  createProviderMutationFn,
  deleteProviderMutationFn,
  updateProviderMutationFn,
} from '../services/providers-service';

export function useProviderCreate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProviderMutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      toast.add({ type: 'success', title: m['dashboard.providers.toast.created']() });
    },
    onError: () => {
      toast.add({ type: 'error', title: m['dashboard.providers.toast.create_failed']() });
    },
  });
}

export function useProviderUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProviderMutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      toast.add({ type: 'success', title: m['dashboard.providers.toast.updated']() });
    },
    onError: () => {
      toast.add({ type: 'error', title: m['dashboard.providers.toast.update_failed']() });
    },
  });
}

export function useProviderDelete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteProviderMutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      toast.add({ type: 'success', title: m['dashboard.providers.toast.deleted']() });
    },
    onError: () => {
      toast.add({ type: 'error', title: m['dashboard.providers.toast.delete_failed']() });
    },
  });
}

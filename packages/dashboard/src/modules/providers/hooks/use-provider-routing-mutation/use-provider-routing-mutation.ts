import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { updateProviderRoutingMutationFn } from '../../services/providers-service';

export const useProviderRoutingMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProviderRoutingMutationFn,
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.providers, response);
      toast.add({ type: 'success', title: m['dashboard.providers.routing.saved']() });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      toast.add({
        type: 'error',
        title:
          error instanceof Error && (error.message === 'stale_revision' || error.message === 'provider_set_changed')
            ? m['dashboard.providers.routing.stale']()
            : m['dashboard.providers.routing.save_failed'](),
      });
    },
  });
};

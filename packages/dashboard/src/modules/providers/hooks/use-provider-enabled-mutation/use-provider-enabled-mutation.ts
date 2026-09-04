import type { DashboardProvidersResponse } from '@aio-proxy/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { updateProviderEnabledMutationFn } from '../../services/providers-service';

export const useProviderEnabledMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProviderEnabledMutationFn,
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.providers });
      const previous = queryClient.getQueryData<DashboardProvidersResponse>(queryKeys.providers);
      queryClient.setQueryData<DashboardProvidersResponse>(queryKeys.providers, (current) =>
        current === undefined
          ? current
          : {
              providers: current.providers.map((provider) =>
                provider.id === id ? { ...provider, enabled } : provider,
              ),
              routingRevision: current.routingRevision,
            },
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.providers, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
  });
};

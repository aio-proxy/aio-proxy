import type { DashboardProvidersResponse } from '@aio-proxy/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { providersQueryKey, updateProviderEnabledMutationFn } from '../../services/providers-service';

export const useProviderEnabledMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProviderEnabledMutationFn,
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: providersQueryKey });
      const previous = queryClient.getQueryData<DashboardProvidersResponse>(providersQueryKey);
      queryClient.setQueryData<DashboardProvidersResponse>(providersQueryKey, (current) =>
        current === undefined
          ? current
          : {
              providers: current.providers.map((provider) =>
                provider.id === id ? { ...provider, enabled } : provider,
              ),
            },
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(providersQueryKey, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: providersQueryKey }),
  });
};

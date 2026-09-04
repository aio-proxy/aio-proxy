import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { reloadConfigMutationFn } from '../../services/reload-service';

export const useReloadMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reloadConfigMutationFn,
    onSuccess: async () => {
      // A reload commits the whole config snapshot, so every config-backed cache is stale.
      // `providers` and `plugins` are prefixes of their own edit-view keys.
      await Promise.all(
        [queryKeys.settings, queryKeys.providers, queryKeys.plugins, queryKeys.routingModels].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
};

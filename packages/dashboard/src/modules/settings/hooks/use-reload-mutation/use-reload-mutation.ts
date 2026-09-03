import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { reloadConfigMutationFn } from '../../services/reload-service';

export const useReloadMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reloadConfigMutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    },
  });
};

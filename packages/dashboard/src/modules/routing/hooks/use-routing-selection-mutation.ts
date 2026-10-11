import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { updateRoutingSelectionMutationFn } from '../services/routing-service';

export const useRoutingSelectionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateRoutingSelectionMutationFn,
    onSuccess: async (data) => {
      queryClient.setQueryData(queryKeys.routingModels, data);
      await queryClient.invalidateQueries({ queryKey: queryKeys.routingModels });
    },
  });
};

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { updateRoutingModelMutationFn } from '../services/routing-service';

export const useRoutingMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateRoutingModelMutationFn,
    onSuccess: async (data) => {
      queryClient.setQueryData(queryKeys.routingModels, data);
      await queryClient.invalidateQueries({ queryKey: queryKeys.routingModels });
    },
  });
};

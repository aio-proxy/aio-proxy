import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { revokeAgentInstallation } from '../../services/agents-service';

export const useRevokeInstallation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeAgentInstallation,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents }),
  });
};

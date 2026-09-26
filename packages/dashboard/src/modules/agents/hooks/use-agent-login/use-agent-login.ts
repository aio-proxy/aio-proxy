import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { agentPendingLoginQueryOptions, decideAgentLogin } from '../../services/agents-service';

/** Watches for the Agent-side login of a freshly configured installation and decides it. */
export const useAgentLogin = (installationId: string) => {
  const queryClient = useQueryClient();
  const pending = useQuery(agentPendingLoginQueryOptions(installationId));
  const decide = useMutation({
    mutationFn: ({ deviceId, decision }: { deviceId: string; decision: 'approve' | 'deny' }) =>
      decideAgentLogin(deviceId, decision),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents }),
  });
  const authorization = pending.data?.authorization;
  return {
    pending: authorization?.status === 'pending' ? authorization : undefined,
    decide: (decision: 'approve' | 'deny') => {
      if (authorization?.status === 'pending') decide.mutate({ deviceId: authorization.deviceId, decision });
    },
    decision: decide.data?.status,
    isDeciding: decide.isPending,
    failed: decide.isError,
  };
};

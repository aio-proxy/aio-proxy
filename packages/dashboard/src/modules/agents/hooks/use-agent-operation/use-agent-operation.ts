import type { AgentOperationRequest, AgentOperationState } from '@aio-proxy/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { agentOperationQueryOptions, decideAgentOperation, startAgentOperation } from '../../services/agents-service';

/** Starts one Agent operation and follows it until it succeeds or fails. */
export const useAgentOperation = () => {
  const queryClient = useQueryClient();
  const [operationId, setOperationId] = useState<string>();
  const remember = (state: AgentOperationState) =>
    queryClient.setQueryData(queryKeys.agentOperation(state.operationId), state);
  const start = useMutation({
    mutationFn: startAgentOperation,
    onSuccess: (state) => {
      remember(state);
      setOperationId(state.operationId);
    },
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny' | 'cancel') => decideAgentOperation(operationId!, decision),
    onSuccess: remember,
  });
  const operation = useQuery({ ...agentOperationQueryOptions(operationId ?? ''), enabled: operationId !== undefined });
  const state = operationId === undefined ? undefined : operation.data;
  const finished = state?.status === 'succeeded' || state?.status === 'failed';
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
  }, [finished, queryClient]);
  return {
    state,
    start: (request: AgentOperationRequest) => start.mutate(request),
    startError: start.error,
    isStarting: start.isPending,
    decide: (decision: 'approve' | 'deny' | 'cancel') => decide.mutate(decision),
    isDeciding: decide.isPending,
    busy: start.isPending || (state !== undefined && !finished),
    reset: () => {
      setOperationId(undefined);
      start.reset();
      decide.reset();
    },
  };
};

import type { AgentOperationKind, AgentOperationRequest, AgentOperationState, AgentTarget } from '@aio-proxy/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryKeys } from '@/lib/query-keys';

import { agentOperationQueryOptions, decideAgentOperation, startAgentOperation } from '../../services/agents-service';
import { useAgentsSnapshot } from '../use-agents-snapshot';

/**
 * Starts one Agent operation and follows it until it succeeds or fails. An unfinished operation of
 * the given kinds that this page did not start (it was reloaded mid-approval) is adopted from the
 * snapshot, because the server keeps refusing new ones for the target until it ends.
 */
export const useAgentOperation = (target: AgentTarget, kinds: readonly AgentOperationKind[]) => {
  const queryClient = useQueryClient();
  const snapshot = useAgentsSnapshot();
  const [startedId, setStartedId] = useState<string>();
  const adopted = snapshot.data?.operations?.find(
    (operation) => operation.target === target && kinds.includes(operation.kind),
  );
  const operationId = startedId ?? adopted?.operationId;
  const remember = (state: AgentOperationState) =>
    queryClient.setQueryData(queryKeys.agentOperation(state.operationId), state);
  const start = useMutation({
    mutationFn: startAgentOperation,
    onSuccess: (state) => {
      remember(state);
      setStartedId(state.operationId);
      // The snapshot must list this operation so a remount within its stale time can adopt it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents, exact: true });
    },
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny' | 'cancel') => decideAgentOperation(operationId!, decision),
    onSuccess: remember,
  });
  const operation = useQuery({ ...agentOperationQueryOptions(operationId ?? ''), enabled: operationId !== undefined });
  const state = operationId === undefined ? undefined : (operation.data ?? adopted);
  const finished = state?.status === 'succeeded' || state?.status === 'failed';
  useEffect(() => {
    if (finished) void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
  }, [finished, queryClient]);
  return {
    state,
    adopted: startedId === undefined && adopted !== undefined,
    start: (request: AgentOperationRequest) => start.mutate(request),
    startError: start.error,
    isStarting: start.isPending,
    decide: (decision: 'approve' | 'deny' | 'cancel') => decide.mutate(decision),
    isDeciding: decide.isPending,
    busy: start.isPending || (state !== undefined && !finished),
    reset: () => {
      setStartedId(undefined);
      start.reset();
      decide.reset();
    },
  };
};

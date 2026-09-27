import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { queryKeys } from '@/lib/query-keys';

import {
  agentPendingLoginQueryOptions,
  agentsSnapshotQueryOptions,
  decideAgentLogin,
} from '../../services/agents-service';

const SNAPSHOT_POLL_MS = 2_000;

/** Watches for the Agent-side login of a freshly configured installation and decides it. */
export const useAgentLogin = (installationId: string) => {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ deviceId, decision }: { deviceId: string; decision: 'approve' | 'deny' }) =>
      decideAgentLogin(deviceId, decision),
    // Also refreshes the pending request, so an expired or already-used one stops showing controls.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents }),
  });
  const settled = decide.data?.status === 'approved' || decide.data?.status === 'denied';
  const pending = useQuery({ ...agentPendingLoginQueryOptions(installationId), enabled: !settled });
  const authorization = pending.data?.authorization;
  // A pending request that disappears was decided here or on another page; either way the Agent
  // may be about to redeem it, so remember when it would have expired.
  const [seenUntil, setSeenUntil] = useState<number>();
  const pendingUntil = authorization?.status === 'pending' ? Date.parse(authorization.expiresAt) : undefined;
  if (pendingUntil !== undefined && pendingUntil !== seenUntil) setSeenUntil(pendingUntil);
  // Approval issues the credential only on the Agent's next token poll, so keep refreshing the
  // snapshot until the installation shows as active.
  const granted = decide.data?.status === 'approved' || decide.data?.status === 'consumed';
  const decidedElsewhere = pendingUntil === undefined && seenUntil !== undefined && decide.data === undefined;
  useQuery({
    ...agentsSnapshotQueryOptions(),
    enabled: granted || decidedElsewhere,
    refetchInterval: (query) =>
      query.state.data?.installations.some(
        (item) => item.installationId === installationId && item.authorization === 'active',
      ) ||
      // An approval the Agent never redeems must not keep scanning Agent hosts forever.
      (seenUntil !== undefined && Date.now() > seenUntil)
        ? false
        : SNAPSHOT_POLL_MS,
  });
  return {
    pending: authorization?.status === 'pending' ? authorization : undefined,
    userCode: authorization?.status === 'pending' ? (pending.data?.userCode ?? undefined) : undefined,
    decide: (decision: 'approve' | 'deny') => {
      if (authorization?.status === 'pending') decide.mutate({ deviceId: authorization.deviceId, decision });
    },
    decision: decide.data?.status,
    isDeciding: decide.isPending,
    failed: decide.isError,
  };
};

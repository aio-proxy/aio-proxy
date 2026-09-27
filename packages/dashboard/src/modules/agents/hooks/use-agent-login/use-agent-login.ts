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
  // Keeps polling after a decision: the Agent may retry and start a new challenge for this installation.
  const pending = useQuery(agentPendingLoginQueryOptions(installationId));
  const pendingNow = pending.data?.authorization?.status === 'pending' ? pending.data.authorization : undefined;
  // The latest pending request seen for this installation. A request that disappears was decided
  // here or on another page; either way the Agent may be about to redeem it, so remember when it
  // would have expired.
  const [seen, setSeen] = useState<{ readonly deviceId: string; readonly until: number }>();
  // A request's expiry is fixed when it is created, so only a new device ID moves it.
  if (pendingNow !== undefined && pendingNow.deviceId !== seen?.deviceId)
    setSeen({ deviceId: pendingNow.deviceId, until: Date.parse(pendingNow.expiresAt) });
  // A decision made here covers only its own request; once the Agent retries, it no longer applies,
  // even after the retried request is itself decided elsewhere and disappears.
  const decidedDevice = decide.variables?.deviceId;
  const stale = decidedDevice !== undefined && seen !== undefined && seen.deviceId !== decidedDevice;
  // A request decided on another page reports that outcome, so a denial there is not mistaken for an
  // approval awaiting redemption.
  const decidedThere = pending.data?.decided ?? undefined;
  const external =
    decidedThere !== undefined && decidedThere.deviceId === seen?.deviceId ? decidedThere.status : undefined;
  const decision = (stale ? undefined : decide.data?.status) ?? external;
  const authorization = decide.data !== undefined && !stale ? undefined : pendingNow;
  const seenUntil = seen?.until;
  // Approval issues the credential only on the Agent's next token poll, so keep refreshing the
  // snapshot until the installation shows as active.
  const granted = decision === 'approved' || decision === 'consumed';
  const decidedElsewhere = pendingNow === undefined && seenUntil !== undefined && decision === undefined;
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
    pending: authorization,
    userCode: authorization === undefined ? undefined : (pending.data?.userCode ?? undefined),
    decide: (decision: 'approve' | 'deny') => {
      if (authorization !== undefined) decide.mutate({ deviceId: authorization.deviceId, decision });
    },
    decision,
    isDeciding: decide.isPending,
    failed: decide.isError,
  };
};

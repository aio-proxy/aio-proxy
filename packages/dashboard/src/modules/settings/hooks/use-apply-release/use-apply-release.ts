import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryKeys } from '@/lib/query-keys';
import { reloadDashboard } from '@/lib/reload-dashboard';

import { applyReleaseMutationFn, releaseQueryOptions } from '../../services/release-service';
import { useReleaseQuery } from '../use-release-query';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;

export type UseApplyReleaseOptions = {
  readonly outdated: boolean;
  readonly onUpToDate?: () => void;
};

const errorCode = (error: unknown) => (error instanceof Error ? error.message : '');

export const useApplyRelease = ({ outdated, onUpToDate }: UseApplyReleaseOptions) => {
  const queryClient = useQueryClient();
  const release = useReleaseQuery();
  const [dismissedAsCurrent, setDismissedAsCurrent] = useState(false);
  const [seenOutdated, setSeenOutdated] = useState(outdated);
  if (outdated !== seenOutdated) {
    setSeenOutdated(outdated);
    if (outdated) setDismissedAsCurrent(false);
  }
  const releaseAvailable = outdated && !dismissedAsCurrent;
  const [baselineCurrent, setBaselineCurrent] = useState(release.data?.current);
  if (baselineCurrent === undefined && release.data?.current !== undefined) {
    setBaselineCurrent(release.data.current);
  }

  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [applyMessage, setApplyMessage] = useState<'failed' | 'unavailable'>();
  const [pollStartedUpdatedAt, setPollStartedUpdatedAt] = useState(0);

  const updateStatus = release.data?.update.status;
  const pollQuery = useQuery({
    ...releaseQueryOptions(),
    enabled: !timedOut && (polling || updateStatus === 'in_progress'),
    refetchInterval: (query) => {
      const view = query.state.data;
      if (view === undefined) return POLL_INTERVAL_MS;
      if (baselineCurrent !== undefined && view.current !== baselineCurrent) return false;
      if (query.state.dataUpdatedAt <= pollStartedUpdatedAt) return POLL_INTERVAL_MS;
      if (
        view.update.status === 'restart_required' ||
        view.update.status === 'failed' ||
        view.update.status === 'idle'
      ) {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: true,
  });

  const pollStatus = pollQuery.data?.update.status;
  const versionChanged =
    baselineCurrent !== undefined && pollQuery.data !== undefined && pollQuery.data.current !== baselineCurrent;
  const freshPollIdle =
    !pollQuery.isFetching && pollQuery.dataUpdatedAt > pollStartedUpdatedAt && pollStatus === 'idle';
  if (freshPollIdle && polling) {
    setPolling(false);
  }
  const pollTerminal =
    pollQuery.dataUpdatedAt > pollStartedUpdatedAt && (pollStatus === 'restart_required' || pollStatus === 'failed');
  if (pollTerminal && polling) {
    setPolling(false);
  }
  const watching =
    !timedOut && !pollTerminal && !versionChanged && !freshPollIdle && (polling || updateStatus === 'in_progress');

  useEffect(() => {
    if (!watching) return;
    const timeout = window.setTimeout(() => setTimedOut(true), POLL_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [watching]);

  useEffect(() => {
    if (versionChanged) reloadDashboard();
  }, [versionChanged]);

  const beginPoll = () => {
    setApplyMessage(undefined);
    setTimedOut(false);
    setPolling(true);
    setPollStartedUpdatedAt(pollQuery.dataUpdatedAt);
  };

  const apply = useMutation({
    mutationFn: applyReleaseMutationFn,
    onSuccess: (result) => {
      if (result.status === 'up_to_date') {
        setDismissedAsCurrent(true);
        onUpToDate?.();
        void queryClient.invalidateQueries({ queryKey: queryKeys.release });
        return;
      }
      if (result.status === 'started') beginPoll();
    },
    onError: (error) => {
      const code = errorCode(error);
      if (code === 'in_progress') {
        beginPoll();
        return;
      }
      if (code === 'unavailable') {
        setApplyMessage('unavailable');
        return;
      }
      if (code === 'check_failed') {
        setApplyMessage('failed');
        return;
      }
      // Transport / unknown errors are ambiguous: the server may already be applying.
      beginPoll();
    },
  });

  const lastKnownInProgress =
    !timedOut && !pollTerminal && !freshPollIdle && (updateStatus === 'in_progress' || pollStatus === 'in_progress');
  const inProgress = !timedOut && (apply.isPending || watching || lastKnownInProgress);
  const restartRequired = updateStatus === 'restart_required' || pollStatus === 'restart_required';
  const failed = timedOut || applyMessage === 'failed' || updateStatus === 'failed' || pollStatus === 'failed';
  const unavailable = applyMessage === 'unavailable';

  return {
    apply: () => apply.mutate(),
    failed,
    inProgress,
    releaseAvailable,
    restartRequired,
    unavailable,
  };
};

import { m } from '@aio-proxy/i18n';
import { toast } from '@aio-proxy/ui/components/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryKeys } from '@/lib/query-keys';
import { reloadDashboard } from '@/lib/reload-dashboard';

import { applyReleaseMutationFn, releaseQueryOptions } from '../../services/release-service';
import { useReleaseQuery } from '../use-release-query';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;

// Keyed so the sidebar card and the About row — both of which mount this hook — update one
// toast instead of stacking two copies of the same outcome.
const OUTCOME_TOASTS = {
  failed: {
    id: 'release-update-failed',
    type: 'error',
    title: m['dashboard.settings.version_update_failed'],
    timeout: undefined,
  },
  restart: {
    id: 'release-update-restart',
    type: 'info',
    title: m['dashboard.settings.version_restart_required'],
    // Restarting is the user's move, so this must not disappear before they read it.
    timeout: 0,
  },
  unavailable: {
    id: 'release-update-unavailable',
    type: 'warning',
    title: m['dashboard.settings.version_update_unavailable'],
    timeout: undefined,
  },
} as const;

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
  const restartPending = updateStatus === 'restart_required';
  const pollQuery = useQuery({
    ...releaseQueryOptions(),
    enabled: !timedOut && (polling || updateStatus === 'in_progress' || restartPending),
    refetchInterval: (query) => {
      const view = query.state.data;
      if (view === undefined) return POLL_INTERVAL_MS;
      if (baselineCurrent !== undefined && view.current !== baselineCurrent) return false;
      if (query.state.dataUpdatedAt <= pollStartedUpdatedAt) return POLL_INTERVAL_MS;
      if (view.update.status === 'failed' || view.update.status === 'idle') {
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
  const pollFailed = pollQuery.dataUpdatedAt > pollStartedUpdatedAt && pollStatus === 'failed';
  if (pollFailed && polling) {
    setPolling(false);
  }
  // The unmanaged helper exits 100ms after install. A 2s poll often never sees
  // the brief `restart_required` GET and keeps the last `in_progress` (or idle)
  // payload after the process is gone. Treat that disconnect as awaiting restart
  // so timeout asks the user to restart instead of calling the install failed.
  const disconnectedDuringApply =
    pollQuery.isError &&
    !pollFailed &&
    !freshPollIdle &&
    !versionChanged &&
    (polling || updateStatus === 'in_progress' || pollStatus === 'in_progress' || restartPending);
  const awaitingRestart = restartPending || pollStatus === 'restart_required' || disconnectedDuringApply;
  const watching =
    !timedOut &&
    !pollFailed &&
    !versionChanged &&
    !freshPollIdle &&
    (polling || updateStatus === 'in_progress' || awaitingRestart);

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
    !timedOut && !pollFailed && !freshPollIdle && (updateStatus === 'in_progress' || pollStatus === 'in_progress');
  const inProgress = apply.isPending || (!timedOut && (watching || lastKnownInProgress || awaitingRestart));
  const restartRequired = timedOut && awaitingRestart;
  const failed =
    (timedOut && !awaitingRestart) || applyMessage === 'failed' || updateStatus === 'failed' || pollStatus === 'failed';
  const unavailable = applyMessage === 'unavailable';

  const outcome = restartRequired ? 'restart' : unavailable ? 'unavailable' : failed ? 'failed' : undefined;
  useEffect(() => {
    if (outcome === undefined) return;
    const { id, type, title, timeout } = OUTCOME_TOASTS[outcome];
    toast.add({ id, type, title: title(), timeout });
  }, [outcome]);

  return {
    apply: () => apply.mutate(),
    failed,
    inProgress,
    releaseAvailable,
    restartRequired,
    unavailable,
  };
};

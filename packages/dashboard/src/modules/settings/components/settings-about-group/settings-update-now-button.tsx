import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { reloadDashboard } from '@/lib/reload-dashboard';

import { useReleaseQuery } from '../../hooks/use-release-query';
import { applyReleaseMutationFn, releaseQueryOptions } from '../../services/release-service';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;

interface SettingsUpdateNowButtonProps {
  readonly outdated: boolean;
}

const errorCode = (error: unknown) => (error instanceof Error ? error.message : '');

export const SettingsUpdateNowButton: React.FC<SettingsUpdateNowButtonProps> = ({ outdated }) => {
  const release = useReleaseQuery();
  const [baselineCurrent, setBaselineCurrent] = useState(release.data?.current);
  if (baselineCurrent === undefined && release.data?.current !== undefined) {
    setBaselineCurrent(release.data.current);
  }

  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [applyMessage, setApplyMessage] = useState<'failed' | 'unavailable'>();

  const updateStatus = release.data?.update.status;
  const pollQuery = useQuery({
    ...releaseQueryOptions(),
    enabled: !timedOut && (polling || updateStatus === 'in_progress'),
    refetchInterval: (query) => {
      const view = query.state.data;
      if (view === undefined) return POLL_INTERVAL_MS;
      if (baselineCurrent !== undefined && view.current !== baselineCurrent) return false;
      if (view.update.status === 'restart_required' || view.update.status === 'failed') return false;
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: true,
  });

  const pollStatus = pollQuery.data?.update.status;
  const versionChanged =
    baselineCurrent !== undefined && pollQuery.data !== undefined && pollQuery.data.current !== baselineCurrent;
  const pollTerminal = pollStatus === 'restart_required' || pollStatus === 'failed';
  const watching = !timedOut && !pollTerminal && !versionChanged && (polling || updateStatus === 'in_progress');

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
  };

  const apply = useMutation({
    mutationFn: applyReleaseMutationFn,
    onSuccess: (result) => {
      if (result.status === 'started') beginPoll();
    },
    onError: (error) => {
      const code = errorCode(error);
      if (code === 'in_progress') {
        beginPoll();
        return;
      }
      setApplyMessage(code === 'unavailable' ? 'unavailable' : 'failed');
    },
  });

  const inProgress = apply.isPending || watching;
  const restartRequired = updateStatus === 'restart_required' || pollStatus === 'restart_required';
  const failed = applyMessage === 'failed' || updateStatus === 'failed' || pollStatus === 'failed';
  const unavailable = applyMessage === 'unavailable';
  const status = restartRequired
    ? m['dashboard.settings.version_restart_required']()
    : unavailable
      ? m['dashboard.settings.version_update_unavailable']()
      : failed
        ? m['dashboard.settings.version_update_failed']()
        : undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={!outdated || inProgress || restartRequired}
        onClick={() => apply.mutate()}
      >
        {inProgress ? m['dashboard.settings.version_updating']() : m['dashboard.settings.version_update']()}
      </Button>
      {status === undefined ? null : <p className="max-w-56 text-right text-xs text-muted-foreground">{status}</p>}
    </div>
  );
};

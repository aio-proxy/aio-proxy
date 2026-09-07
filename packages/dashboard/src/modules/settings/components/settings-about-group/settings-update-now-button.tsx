import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

import { useApplyRelease } from '@/modules/settings/hooks/use-apply-release';

interface SettingsUpdateNowButtonProps {
  readonly outdated: boolean;
  readonly onUpToDate?: () => void;
}

export const SettingsUpdateNowButton: React.FC<SettingsUpdateNowButtonProps> = ({ outdated, onUpToDate }) => {
  const { apply, failed, inProgress, releaseAvailable, restartRequired, unavailable } = useApplyRelease({
    outdated,
    onUpToDate,
  });
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
        disabled={!releaseAvailable || inProgress || restartRequired}
        onClick={() => apply()}
      >
        {inProgress ? m['dashboard.settings.version_updating']() : m['dashboard.settings.version_update']()}
      </Button>
      {status === undefined ? null : <p className="max-w-56 text-right text-xs text-muted-foreground">{status}</p>}
    </div>
  );
};

import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

interface SettingsUpdateNowButtonProps {
  readonly apply: () => void;
  readonly failed: boolean;
  readonly inProgress: boolean;
  readonly releaseAvailable: boolean;
  readonly restartRequired: boolean;
  readonly unavailable: boolean;
}

export const SettingsUpdateNowButton: React.FC<SettingsUpdateNowButtonProps> = ({
  apply,
  failed,
  inProgress,
  releaseAvailable,
  restartRequired,
  unavailable,
}) => {
  // Nothing to install and nothing to retry: a permanently greyed-out button next to
  // "Check for updates" is noise, not an affordance. Outcomes are reported by toast.
  if (!releaseAvailable && !inProgress && !restartRequired && !failed && !unavailable) return null;

  return (
    <Button variant="ghost" size="sm" disabled={!releaseAvailable || inProgress || restartRequired} onClick={apply}>
      {inProgress ? m['dashboard.settings.version_updating']() : m['dashboard.settings.version_update']()}
    </Button>
  );
};

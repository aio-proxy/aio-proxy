import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

import { useRevokeInstallation } from '../../hooks/use-revoke-installation';

interface RevokeInstallationButtonProps {
  readonly installationId: string;
  readonly disabled: boolean;
}

export const RevokeInstallationButton: React.FC<RevokeInstallationButtonProps> = ({ installationId, disabled }) => {
  const revoke = useRevokeInstallation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || revoke.isPending}
      onClick={() => revoke.mutate(installationId)}
    >
      {m['dashboard.agents.action.revoke']()}
    </Button>
  );
};

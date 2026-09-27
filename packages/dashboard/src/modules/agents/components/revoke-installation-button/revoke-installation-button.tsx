import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { toast } from '@aio-proxy/ui/components/toast';

import { useRevokeInstallation } from '../../hooks/use-revoke-installation';
import { errorMessage } from '../../lib/agent-labels';
import { AgentsRequestError } from '../../services/agents-service';

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
      onClick={() =>
        revoke.mutate(installationId, {
          // The row simply stays active on failure, so say that the credential was not revoked.
          onError: (error) =>
            toast.add({
              type: 'error',
              title: m['dashboard.agents.revoke_failed'](),
              description: errorMessage(error instanceof AgentsRequestError ? error.code : 'request_failed'),
            }),
        })
      }
    >
      {m['dashboard.agents.action.revoke']()}
    </Button>
  );
};

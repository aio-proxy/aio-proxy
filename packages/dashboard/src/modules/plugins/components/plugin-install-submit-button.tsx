import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

interface PluginInstallSubmitButtonProps {
  readonly confirmationRequired: boolean;
  readonly isPending: boolean;
  readonly isSubmitting: boolean;
  readonly isValid: boolean;
  readonly trustConfirmed: boolean;
}

export const PluginInstallSubmitButton: React.FC<PluginInstallSubmitButtonProps> = ({
  confirmationRequired,
  isPending,
  isSubmitting,
  isValid,
  trustConfirmed,
}) => (
  <Button type="submit" disabled={!isValid || (confirmationRequired && !trustConfirmed) || isSubmitting || isPending}>
    {m['dashboard.plugins.install_action']()}
  </Button>
);

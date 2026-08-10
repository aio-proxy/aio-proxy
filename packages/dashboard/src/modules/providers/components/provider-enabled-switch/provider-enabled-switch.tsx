import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Switch } from '@aio-proxy/ui/components/switch';
import type React from 'react';

import { useProviderEnabledMutation } from '../../hooks/use-provider-enabled-mutation';

interface ProviderEnabledSwitchProps {
  readonly provider: DashboardProviderSummary;
}

export const ProviderEnabledSwitch: React.FC<ProviderEnabledSwitchProps> = ({ provider }) => {
  const mutation = useProviderEnabledMutation();
  return (
    <Switch
      checked={provider.enabled}
      disabled={mutation.isPending}
      aria-label={
        provider.enabled
          ? m['dashboard.providers.actions.disable_provider']({ id: provider.id })
          : m['dashboard.providers.actions.enable_provider']({ id: provider.id })
      }
      onCheckedChange={(enabled) => mutation.mutate({ id: provider.id, enabled })}
    />
  );
};

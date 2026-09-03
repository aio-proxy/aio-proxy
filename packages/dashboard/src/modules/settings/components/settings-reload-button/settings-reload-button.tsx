import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { toast } from '@aio-proxy/ui/components/toast';
import { RefreshCw } from 'lucide-react';

import { useReloadMutation } from '../../hooks/use-reload-mutation';
import { ReloadFailedError } from '../../services/reload-service';

export const SettingsReloadButton: React.FC = () => {
  const reload = useReloadMutation();

  return (
    <Button
      type="button"
      variant="outline"
      disabled={reload.isPending}
      onClick={() =>
        reload.mutate(undefined, {
          onError: (error) => {
            toast.add({
              type: 'error',
              title: m['dashboard.settings.reload_failed']({
                stage: error instanceof ReloadFailedError ? error.stage : 'unknown',
              }),
            });
          },
          onSuccess: () => {
            toast.add({ type: 'success', title: m['dashboard.settings.reload_succeeded']() });
          },
        })
      }
    >
      <RefreshCw />
      {m['dashboard.settings.reload']()}
    </Button>
  );
};

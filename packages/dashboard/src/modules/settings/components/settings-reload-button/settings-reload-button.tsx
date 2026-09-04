import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { toast } from '@aio-proxy/ui/components/toast';
import { RefreshCw } from 'lucide-react';

import { useReloadMutation } from '../../hooks/use-reload-mutation';
import { ReloadFailedError } from '../../services/reload-service';

// The server's stage identifiers are internal English tokens, so they cannot be interpolated
// into a translated sentence directly. An unrecognized stage falls back to "unknown" rather
// than leaking the raw token into a localized message.
const STAGE_MESSAGES: Record<string, () => string> = {
  'alias-collision': m['dashboard.settings.reload_failed_stage_alias_collision'],
  parse: m['dashboard.settings.reload_failed_stage_parse'],
  providers: m['dashboard.settings.reload_failed_stage_providers'],
  router: m['dashboard.settings.reload_failed_stage_router'],
};

const stageLabel = (error: unknown) => {
  const stage = error instanceof ReloadFailedError ? STAGE_MESSAGES[error.stage] : undefined;
  return (stage ?? m['dashboard.settings.reload_failed_stage_unknown'])();
};

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
              title: m['dashboard.settings.reload_failed']({ stage: stageLabel(error) }),
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

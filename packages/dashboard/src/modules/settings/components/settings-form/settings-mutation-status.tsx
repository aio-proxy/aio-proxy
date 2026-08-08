import { m } from '@aio-proxy/i18n';

import type { DashboardSettingsMutationSuccess } from '../../services/settings-service';

interface SettingsMutationStatusProps {
  readonly data: DashboardSettingsMutationSuccess | undefined;
  readonly isError: boolean;
}

export const SettingsMutationStatus: React.FC<SettingsMutationStatusProps> = ({ data, isError }) => (
  <>
    {data === undefined ? null : (
      <p role="status" className="text-sm text-muted-foreground">
        {m['dashboard.settings.saved']()}
        {data.restartRequired ? ` ${m['dashboard.settings.restart_required']()}` : null}
      </p>
    )}
    {isError ? (
      <p role="alert" className="text-sm text-destructive">
        {m['dashboard.settings.save_failed']()}
      </p>
    ) : null}
  </>
);

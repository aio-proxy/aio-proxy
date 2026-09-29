import { m } from '@aio-proxy/i18n';
import { Alert, AlertAction, AlertDescription } from '@aio-proxy/ui/components/alert';
import { Button } from '@aio-proxy/ui/components/button';
import type React from 'react';

interface PluginFailedAlertProps {
  readonly count: number;
  readonly onView: () => void;
}

export const PluginFailedAlert: React.FC<PluginFailedAlertProps> = ({ count, onView }) => (
  <Alert variant="destructive">
    <AlertDescription>{m['dashboard.plugins.failed_summary']({ count })}</AlertDescription>
    <AlertAction>
      <Button type="button" size="sm" variant="outline" onClick={onView}>
        {m['dashboard.plugins.failed_view']()}
      </Button>
    </AlertAction>
  </Alert>
);

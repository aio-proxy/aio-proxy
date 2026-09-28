import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import type React from 'react';

interface RoutingTrafficRefreshNoticeProps {
  readonly onRetry: () => void;
}

/** Traffic still on screen is the last successful measurement; this says the refresh behind it failed. */
export const RoutingTrafficRefreshNotice: React.FC<RoutingTrafficRefreshNoticeProps> = ({ onRetry }) => (
  <div className="flex flex-wrap items-center gap-3">
    <p role="status" className="text-sm text-muted-foreground">
      {m['dashboard.routing.traffic.refresh_failed']()}
    </p>
    <Button type="button" size="sm" variant="outline" onClick={onRetry}>
      {m['dashboard.routing.retry']()}
    </Button>
  </div>
);

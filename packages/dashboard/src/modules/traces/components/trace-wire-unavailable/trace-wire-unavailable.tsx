import { m } from '@aio-proxy/i18n';
import type { DashboardTraceWireResponse } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty, EmptyDescription } from '@aio-proxy/ui/components/empty';
import { Link } from '@tanstack/react-router';

// 服务端只在算得出保留天数时才带上它；带不上时不编一个数字。
const UNKNOWN_RETENTION_DAYS = '?';

interface TraceWireUnavailableProps {
  readonly reason: DashboardTraceWireResponse['reason'];
  readonly retentionDays: number | undefined;
}

/**
 * 默认配置下抓包是关着的，所以这块是常态而不是异常：不静默隐藏、不给一个空列表，
 * 明说少了什么、去哪儿打开。
 */
export const TraceWireUnavailable: React.FC<TraceWireUnavailableProps> = ({ reason, retentionDays }) => (
  <Empty>
    <EmptyDescription>
      {reason === 'missing'
        ? m['dashboard.traces.wire_unavailable_retention']({ days: retentionDays ?? UNKNOWN_RETENTION_DAYS })
        : m['dashboard.traces.wire_unavailable_debug']()}
    </EmptyDescription>
    <Button variant="outline" nativeButton={false} render={<Link to="/settings" />}>
      {m['dashboard.traces.wire_open_settings']()}
    </Button>
  </Empty>
);

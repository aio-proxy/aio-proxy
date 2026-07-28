import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TraceStatusProps {
  readonly item: Pick<DashboardTraceSummary | DashboardTraceSpan, 'endedAt' | 'otelStatusCode' | 'terminationReason'>;
  readonly className?: string;
}

type DisplayStatus = 'running' | 'success' | 'failure' | 'cancelled' | 'interrupted' | 'error';

const statusLabels: Record<DisplayStatus, () => string> = {
  running: m['dashboard.traces.running'],
  success: m['dashboard.traces.success'],
  failure: m['dashboard.traces.failure'],
  cancelled: m['dashboard.traces.cancelled'],
  interrupted: m['dashboard.traces.interrupted'],
  error: m['dashboard.traces.otel_error'],
};
const statusVariants = {
  running: 'secondary',
  success: 'default',
  failure: 'destructive',
  cancelled: 'outline',
  interrupted: 'outline',
  error: 'destructive',
} as const satisfies Record<DisplayStatus, 'secondary' | 'default' | 'destructive' | 'outline'>;

const displayStatus = (item: TraceStatusProps['item']): DisplayStatus => {
  if (item.endedAt === null) return 'running';
  if (item.terminationReason !== undefined) return item.terminationReason;
  return item.otelStatusCode === 'ERROR' ? 'error' : 'success';
};

export const TraceStatus: React.FC<TraceStatusProps> = ({ item, className }) => {
  const status = displayStatus(item);
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      <Badge variant={statusVariants[status]}>{statusLabels[status]()}</Badge>
    </div>
  );
};

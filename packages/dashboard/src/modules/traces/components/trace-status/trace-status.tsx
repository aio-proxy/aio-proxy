import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { cn } from '@aio-proxy/ui/lib/utils';
import { cva } from 'class-variance-authority';

interface TraceStatusProps {
  readonly item: Pick<DashboardTraceSummary | DashboardTraceSpan, 'endedAt' | 'otelStatusCode' | 'terminationReason'>;
  readonly className?: string;
}

type DisplayStatus = 'running' | 'success' | 'failure' | 'cancelled' | 'interrupted';

const statusLabels: Record<DisplayStatus, () => string> = {
  running: m['dashboard.traces.running'],
  success: m['dashboard.traces.success'],
  failure: m['dashboard.traces.failure'],
  cancelled: m['dashboard.traces.cancelled'],
  interrupted: m['dashboard.traces.interrupted'],
};

const traceStatusVariants = cva('', {
  variants: {
    status: {
      running: 'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
      success: 'border-transparent bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
      failure: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
      cancelled: '',
      interrupted: '',
    },
  },
});

const displayStatus = (item: TraceStatusProps['item']): DisplayStatus => {
  if (item.endedAt === null) return 'running';
  if (item.terminationReason !== undefined) return item.terminationReason;
  return item.otelStatusCode === 'ERROR' ? 'failure' : 'success';
};

export const TraceStatus: React.FC<TraceStatusProps> = ({ item, className }) => {
  const status = displayStatus(item);
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      <Badge variant="outline" className={traceStatusVariants({ status })} data-status={status}>
        {statusLabels[status]()}
      </Badge>
    </div>
  );
};

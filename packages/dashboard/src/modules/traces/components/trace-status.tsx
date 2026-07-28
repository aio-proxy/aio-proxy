import { m } from '@aio-proxy/i18n';
import type {
  DashboardTraceSpan,
  DashboardTraceSummary,
  OtelSpanStatusCode,
  TraceTerminationReason,
} from '@aio-proxy/types';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TraceStatusProps {
  readonly item: Pick<DashboardTraceSummary | DashboardTraceSpan, 'endedAt' | 'otelStatusCode' | 'terminationReason'>;
  readonly className?: string;
}

const statusLabels: Record<OtelSpanStatusCode, () => string> = {
  UNSET: m['dashboard.traces.otel_unset'],
  OK: m['dashboard.traces.otel_ok'],
  ERROR: m['dashboard.traces.otel_error'],
};
const statusVariants = {
  UNSET: 'outline',
  OK: 'default',
  ERROR: 'destructive',
} as const satisfies Record<OtelSpanStatusCode, 'outline' | 'default' | 'destructive'>;
const terminationLabel = (reason: TraceTerminationReason) => m[`dashboard.traces.${reason}`]();

export const traceStatusLabel = (status: OtelSpanStatusCode): string => statusLabels[status]();

export const TraceStatus: React.FC<TraceStatusProps> = ({ item, className }) => (
  <div className={cn('flex flex-wrap gap-1', className)}>
    {item.endedAt === null ? (
      <Badge variant="secondary">{m['dashboard.traces.running']()}</Badge>
    ) : (
      <Badge variant={statusVariants[item.otelStatusCode]}>{traceStatusLabel(item.otelStatusCode)}</Badge>
    )}
    {item.terminationReason === undefined ? null : (
      <Badge variant="outline">{terminationLabel(item.terminationReason)}</Badge>
    )}
  </div>
);

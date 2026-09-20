import type { DashboardTraceSpan } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';

import type { SpanMetrics } from '../../lib/span-metrics';
import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';
import { isFailedSpan } from '../../lib/trace-failure';
import { TraceStatus } from '../trace-status';

interface SpanStatusRowProps {
  readonly span: DashboardTraceSpan;
  readonly metrics: SpanMetrics;
}

export const SpanStatusRow: React.FC<SpanStatusRowProps> = ({ span, metrics }) => {
  // Provider ID and model ID are identifiers: never translated, joined only when both exist.
  const identity = [metrics.providerId, metrics.modelId].filter((value) => value !== undefined).join(' · ');
  const failed = isFailedSpan(span);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="span-status-row">
      {/* 有状态码也要把终态说出来，不能用它替掉：raw 流式可能先回 200、之后在消费 body 时被
          取消或失败，completionFinish 两个都记下来了。只显示 200 等于把中止说成正常完成，
          而失败则只剩徽章颜色一个载体。 */}
      {metrics.httpStatus !== undefined && (
        <Badge variant={failed ? 'destructive' : 'secondary'} className="font-mono tabular-nums">
          {metrics.httpStatus}
        </Badge>
      )}
      {(metrics.httpStatus === undefined || span.terminationReason !== undefined || span.endedAt === null) && (
        <TraceStatus item={span} />
      )}
      {/* 面板不再有标题，选中的是哪一跳只能靠这里说清楚。 */}
      <span className="min-w-0 truncate font-medium">{span.name}</span>
      <span className="ms-auto min-w-0 text-xs wrap-break-word text-muted-foreground">
        {identity.length === 0 ? TRACE_PLACEHOLDER : identity}
      </span>
    </div>
  );
};

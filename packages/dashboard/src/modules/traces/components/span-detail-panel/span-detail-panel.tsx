import type { DashboardTracePercentile, DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { Card, CardContent } from '@aio-proxy/ui/components/card';

import { readSpanMetrics } from '../../lib/span-metrics';
import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';
import { formatTraceResultDetails } from '../../lib/trace-formatters';
import type { TraceFilterPatch } from '../../lib/trace-search';
import { TracePercentileBar } from '../trace-percentile-bar';
import { SpanAttributeTable } from './span-attribute-table';
import { SpanLinkList } from './span-link-list';
import { SpanMetricGrid } from './span-metric-grid';
import { SpanStatusRow } from './span-status-row';

interface SpanDetailPanelProps {
  readonly span: DashboardTraceSpan | undefined;
  readonly trace: DashboardTraceSummary;
  readonly spans: readonly DashboardTraceSpan[];
  /** 整条调用链的分位对比，不是这个 span 的：样本不足或还没到就不渲染。 */
  readonly comparison?: DashboardTracePercentile | null;
  readonly onFilter: (patch: TraceFilterPatch) => void;
}

// 四块，从上到下：状态行 / 指标网格 / 分位对比 / 属性。span 的 traceId、spanId、起止时刻
// 不再单列一张表 —— traceId 在面包屑上，时间轴在左边瀑布图上，那张表只是把它们又抄了一遍。
// events 不渲染：recorder 永远写空数组，那块 tab 在真实数据上从来没内容。
export const SpanDetailPanel: React.FC<SpanDetailPanelProps> = ({ span, trace, spans, comparison, onFilter }) => {
  const metrics = span === undefined ? undefined : readSpanMetrics({ span, spans, trace });
  const resultDetails =
    span === undefined ? undefined : formatTraceResultDetails({ errorType: span.errorType, errorCode: span.errorCode });

  return (
    <Card data-testid="span-detail-panel" className="min-w-0">
      <CardContent className="min-w-0 space-y-3.5">
        {span === undefined || metrics === undefined ? (
          <p className="text-muted-foreground">{TRACE_PLACEHOLDER}</p>
        ) : (
          <>
            <SpanStatusRow span={span} metrics={metrics} />
            {/* 失败原因是这页存在的理由，留在状态行下面，不塞进属性表里等人去搜。 */}
            {resultDetails === undefined ? null : (
              <p className="font-mono text-xs break-all text-destructive">{resultDetails}</p>
            )}
            <SpanMetricGrid metrics={metrics} />
            <TracePercentileBar comparison={comparison} />
            <SpanAttributeTable
              attributes={span.attributes}
              // root 和那条推理 span 说的都是整条链。推理 span 的结构特征是「CLIENT 且父亲
              // 是 root」：parse / session.resolve / route.resolve 都是默认的 INTERNAL，
              // 上游 HTTP 那些 CLIENT span 挂在 attempt 下而不是 root 下，attempt 自己也是
              // INTERNAL —— 包括老数据里直接挂在 root 下的那些。
              tracewide={
                span.spanId === trace.rootSpanId || (span.kind === 'CLIENT' && span.parentSpanId === trace.rootSpanId)
              }
              onFilter={onFilter}
            />
            {span.links.length === 0 ? null : <SpanLinkList links={span.links} />}
          </>
        )}
      </CardContent>
    </Card>
  );
};

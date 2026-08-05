import type { DashboardTraceSpan } from '@aio-proxy/types';

export interface TraceSpanLayout extends DashboardTraceSpan {
  readonly depth: number;
  readonly offsetRatio: number;
  readonly widthRatio: number;
  readonly durationMs: number;
}

const minimumBarRatio = 0.002;

export const layoutTraceSpans = (spans: readonly DashboardTraceSpan[], now: Date): readonly TraceSpanLayout[] => {
  if (spans.length === 0) return [];

  const spansById = new Map(spans.map((span) => [span.spanId, span]));
  const root = spans.find((span) => span.parentSpanId === undefined) ?? spans[0]!;
  const traceStart = Date.parse(root.startedAt);
  const spanEnd = (span: DashboardTraceSpan) => (span.endedAt === null ? now.getTime() : Date.parse(span.endedAt));
  const traceEnd = Math.max(spanEnd(root), ...spans.map(spanEnd));
  const scaleDurationMs = Math.max(1, traceEnd - traceStart);

  return spans.map((span) => {
    const startedAt = Date.parse(span.startedAt);
    const durationMs = Math.max(0, spanEnd(span) - startedAt);
    const offsetRatio = Math.min(Math.max((startedAt - traceStart) / scaleDurationMs, 0), 1 - minimumBarRatio);
    const widthRatio = Math.min(Math.max(durationMs / scaleDurationMs, minimumBarRatio), 1 - offsetRatio);
    let depth = 0;
    let current = span;
    const visited = new Set([span.spanId]);

    while (current.parentSpanId !== undefined) {
      const parent = spansById.get(current.parentSpanId);
      if (parent === undefined || visited.has(parent.spanId)) {
        depth = 0;
        break;
      }
      visited.add(parent.spanId);
      depth += 1;
      current = parent;
    }

    return { ...span, depth, offsetRatio, widthRatio, durationMs };
  });
};

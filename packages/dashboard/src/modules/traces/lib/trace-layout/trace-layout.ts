import type { DashboardTraceSpan } from '@aio-proxy/types';

import { traceAttribute } from '../trace-attribute-names';

export interface TraceSpanLayout extends DashboardTraceSpan {
  readonly depth: number;
  readonly offsetRatio: number;
  readonly widthRatio: number;
  readonly durationMs: number;
  /** Total trace span the ratios are relative to. Identical on every row. */
  readonly scaleDurationMs: number;
  /** 首字时刻在整条 trace 坐标系里的位置，与 offsetRatio 同一个基准。测不到就没有这个字段。 */
  readonly ttftRatio?: number;
}

const minimumBarRatio = 0.002;

// 首字是一个时刻，不是一段时间：只给位置，不给宽度。
const ttftRatioOf = (
  span: DashboardTraceSpan,
  startedAt: number,
  traceStart: number,
  scaleDurationMs: number,
): number | undefined => {
  const ttftMs = span.attributes[traceAttribute.attemptTtftMs];
  // 同一个 attempt 内观测到多次响应时首字无法归因到哪一次，宁可不画。
  if (span.attributes[traceAttribute.transportObservation] === 'ambiguous') return undefined;
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) return undefined;
  const ratio = (startedAt - traceStart + ttftMs) / scaleDurationMs;
  return ratio < 0 || ratio > 1 ? undefined : ratio;
};

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

    const ttftRatio = ttftRatioOf(span, startedAt, traceStart, scaleDurationMs);

    return {
      ...span,
      depth,
      offsetRatio,
      widthRatio,
      durationMs,
      scaleDurationMs,
      ...(ttftRatio === undefined ? {} : { ttftRatio }),
    };
  });
};

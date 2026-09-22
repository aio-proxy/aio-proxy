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
  const rawTtftMs = span.attributes[traceAttribute.inferenceTtftMs] ?? span.attributes[traceAttribute.attemptTtftMs];
  const genAiSeconds = span.attributes[traceAttribute.genAiTimeToFirstChunk];
  const ttftMs = rawTtftMs ?? (typeof genAiSeconds === 'number' ? genAiSeconds * 1000 : undefined);
  // 同一个 attempt 内观测到多次响应时首字无法归因到哪一次，宁可不画。
  if (
    span.attributes[traceAttribute.transportObservation] === 'ambiguous' ||
    span.attributes[traceAttribute.legacyTransportObservation] === 'ambiguous'
  )
    return undefined;
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) return undefined;
  const ratio = (startedAt - traceStart + ttftMs) / scaleDurationMs;
  return ratio < 0 || ratio > 1 ? undefined : ratio;
};

/**
 * Depth per span, plus the spans whose parent chain does not reach a real root.
 *
 * A missing parent (partially fetched trace) or a cycle (corrupt data) both land at depth 0 and
 * are reported as `rootless`, so the caller can render them instead of dropping them.
 */
const measureDepths = (
  spans: readonly DashboardTraceSpan[],
  spansById: ReadonlyMap<string, DashboardTraceSpan>,
): { readonly depths: ReadonlyMap<string, number>; readonly rootless: ReadonlySet<string> } => {
  const depths = new Map<string, number>();
  const rootless = new Set<string>();

  for (const span of spans) {
    let depth = 0;
    let current = span;
    const seen = new Set([span.spanId]);

    while (current.parentSpanId !== undefined) {
      const parent = spansById.get(current.parentSpanId);
      if (parent === undefined || seen.has(parent.spanId)) {
        depth = 0;
        rootless.add(span.spanId);
        break;
      }
      seen.add(parent.spanId);
      depth += 1;
      current = parent;
    }

    depths.set(span.spanId, depth);
  }

  return { depths, rootless };
};

/**
 * Row order comes from the parent/child structure, never from the API's `startedAt` sort.
 *
 * The server opens a `prepare` span with no await after its `attempt` parent, so the two share a
 * stored millisecond in most traces and the API's `spanId` tiebreak then decides which comes first.
 * Their hrtimes also lack a common epoch anchor, so after truncation a child's millisecond can be
 * strictly smaller than its parent's. Sorting on time alone therefore renders a child above the row
 * it is indented under. Structure decides nesting; time only orders siblings.
 *
 * Every span is emitted exactly once: a span is either a root here (parentless, orphaned, or in a
 * cycle) or reachable from one, because an intact parent chain makes every ancestor intact too.
 */
const orderDepthFirst = (
  spans: readonly DashboardTraceSpan[],
  rootless: ReadonlySet<string>,
): readonly DashboardTraceSpan[] => {
  // Same-millisecond siblings fall back to the span id purely so the order is stable across
  // renders; which of the two wins carries no meaning.
  const bySiblingOrder = (a: DashboardTraceSpan, b: DashboardTraceSpan) => {
    if (a.startSequence !== undefined && b.startSequence !== undefined) return a.startSequence - b.startSequence;
    return Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.spanId < b.spanId ? -1 : 1);
  };

  const childrenByParent = new Map<string, DashboardTraceSpan[]>();
  const roots: DashboardTraceSpan[] = [];

  for (const span of spans) {
    const parentSpanId = span.parentSpanId;
    // Orphans and cycle members render as their own roots, in start order among the real roots.
    if (parentSpanId === undefined || rootless.has(span.spanId)) {
      roots.push(span);
      continue;
    }
    const siblings = childrenByParent.get(parentSpanId);
    if (siblings === undefined) childrenByParent.set(parentSpanId, [span]);
    else siblings.push(span);
  }

  const ordered: DashboardTraceSpan[] = [];
  const visit = (span: DashboardTraceSpan): void => {
    ordered.push(span);
    for (const child of (childrenByParent.get(span.spanId) ?? []).sort(bySiblingOrder)) visit(child);
  };
  for (const root of roots.sort(bySiblingOrder)) visit(root);

  return ordered;
};

export const layoutTraceSpans = (spans: readonly DashboardTraceSpan[], now: Date): readonly TraceSpanLayout[] => {
  if (spans.length === 0) return [];

  const spansById = new Map(spans.map((span) => [span.spanId, span]));
  const root = spans.find((span) => span.parentSpanId === undefined) ?? spans[0]!;
  const traceStart = Date.parse(root.startedAt);
  const spanEnd = (span: DashboardTraceSpan) => (span.endedAt === null ? now.getTime() : Date.parse(span.endedAt));
  const traceEnd = Math.max(spanEnd(root), ...spans.map(spanEnd));
  const scaleDurationMs = Math.max(1, traceEnd - traceStart);
  const { depths, rootless } = measureDepths(spans, spansById);

  return orderDepthFirst(spans, rootless).map((span) => {
    const startedAt = Date.parse(span.startedAt);
    const durationMs = Math.max(0, spanEnd(span) - startedAt);
    const offsetRatio = Math.min(Math.max((startedAt - traceStart) / scaleDurationMs, 0), 1 - minimumBarRatio);
    const widthRatio = Math.min(Math.max(durationMs / scaleDurationMs, minimumBarRatio), 1 - offsetRatio);
    const ttftRatio = ttftRatioOf(span, startedAt, traceStart, scaleDurationMs);

    return {
      ...span,
      depth: depths.get(span.spanId) ?? 0,
      offsetRatio,
      widthRatio,
      durationMs,
      scaleDurationMs,
      ...(ttftRatio === undefined ? {} : { ttftRatio }),
    };
  });
};

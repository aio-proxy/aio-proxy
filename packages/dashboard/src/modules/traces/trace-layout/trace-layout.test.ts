import type { DashboardTraceSpan } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';

import { layoutTraceSpans } from './trace-layout';

const traceId = 'a'.repeat(32);
const span = (
  spanId: string,
  startedAt: string,
  endedAt: string | null,
  parentSpanId?: string,
): DashboardTraceSpan => ({
  traceId,
  spanId,
  ...(parentSpanId === undefined ? {} : { parentSpanId }),
  name: spanId,
  kind: 'INTERNAL',
  startedAt,
  endedAt,
  durationMs: endedAt === null ? 0 : Date.parse(endedAt) - Date.parse(startedAt),
  otelStatusCode: endedAt === null ? 'UNSET' : 'OK',
  attributes: {},
  events: [],
  links: [],
});

describe('layoutTraceSpans', () => {
  test('keeps API order while laying out nested and overlapping Spans', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    const attempt = span('attempt', '2026-07-12T08:00:00.010Z', '2026-07-12T08:00:00.090Z', 'root');
    const inference = span('inference', '2026-07-12T08:00:00.020Z', '2026-07-12T08:00:00.070Z', 'attempt');
    const egress = span('egress', '2026-07-12T08:00:00.050Z', '2026-07-12T08:00:00.080Z', 'attempt');

    const rows = layoutTraceSpans([root, attempt, inference, egress], new Date('2026-07-12T08:00:01.000Z'));

    expect(rows).toEqual([
      expect.objectContaining({ spanId: 'root', depth: 0, offsetRatio: 0, widthRatio: 1 }),
      expect.objectContaining({ spanId: 'attempt', depth: 1, offsetRatio: 0.1, widthRatio: 0.8 }),
      expect.objectContaining({ spanId: 'inference', depth: 2, offsetRatio: 0.2, widthRatio: 0.5 }),
      expect.objectContaining({ spanId: 'egress', depth: 2, offsetRatio: 0.5, widthRatio: 0.3 }),
    ]);
    expect(rows[2]!.offsetRatio + rows[2]!.widthRatio).toBeGreaterThan(rows[3]!.offsetRatio);
  });

  test('renders orphaned and cyclic parents at depth zero and uses now for a running Span', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    const running = span('running', '2026-07-12T08:00:00.020Z', null, 'root');
    const orphan = span('orphan', '2026-07-12T08:00:00.030Z', '2026-07-12T08:00:00.040Z', 'missing');
    const cycleA = span('cycle-a', '2026-07-12T08:00:00.040Z', '2026-07-12T08:00:00.050Z', 'cycle-b');
    const cycleB = span('cycle-b', '2026-07-12T08:00:00.050Z', '2026-07-12T08:00:00.060Z', 'cycle-a');

    const rows = layoutTraceSpans([root, running, orphan, cycleA, cycleB], new Date('2026-07-12T08:00:00.150Z'));

    expect(rows.map(({ spanId, depth }) => ({ spanId, depth }))).toEqual([
      { spanId: 'root', depth: 0 },
      { spanId: 'running', depth: 1 },
      { spanId: 'orphan', depth: 0 },
      { spanId: 'cycle-a', depth: 0 },
      { spanId: 'cycle-b', depth: 0 },
    ]);
    expect(rows[1]).toEqual(expect.objectContaining({ durationMs: 130, offsetRatio: 0.02 / 0.15 }));
  });
});

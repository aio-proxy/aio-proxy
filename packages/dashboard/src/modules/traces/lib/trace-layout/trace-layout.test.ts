import { spawnSync } from 'node:child_process';

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
  test('orders rows depth-first while laying out nested and overlapping Spans', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    const attempt = span('attempt', '2026-07-12T08:00:00.010Z', '2026-07-12T08:00:00.090Z', 'root');
    const inference = span('inference', '2026-07-12T08:00:00.020Z', '2026-07-12T08:00:00.070Z', 'attempt');
    const egress = span('egress', '2026-07-12T08:00:00.050Z', '2026-07-12T08:00:00.080Z', 'attempt');

    // Deliberately not handed over in tree order: the rows must come from the parent/child
    // structure, not from the order the API happened to return.
    const rows = layoutTraceSpans([egress, root, inference, attempt], new Date('2026-07-12T08:00:01.000Z'));

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

    // A span whose parent is missing or cyclic becomes its own root rather than being dropped:
    // a partly fetched or corrupt trace still shows every row it has, exactly once.
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.spanId)).size).toBe(5);
    expect(rows.map(({ spanId, depth }) => ({ spanId, depth }))).toEqual([
      { spanId: 'root', depth: 0 },
      { spanId: 'running', depth: 1 },
      { spanId: 'orphan', depth: 0 },
      { spanId: 'cycle-a', depth: 0 },
      { spanId: 'cycle-b', depth: 0 },
    ]);
    expect(rows[1]).toEqual(expect.objectContaining({ durationMs: 130, offsetRatio: 0.02 / 0.15 }));
  });

  test('exposes a shared scale that covers a child outliving the root Span', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    const late = span('late', '2026-07-12T08:00:00.010Z', '2026-07-12T08:00:00.160Z', 'root');

    const rows = layoutTraceSpans([root, late], new Date('2026-07-12T08:00:01.000Z'));

    // The root Span lasts 100ms but the trace spans 160ms, so the scale must follow the trace,
    // not the root duration — otherwise the ruler labels understate every bar.
    expect(rows.map((row) => row.scaleDurationMs)).toEqual([160, 160]);
    expect(rows[0]).toEqual(expect.objectContaining({ durationMs: 100, widthRatio: 100 / 160 }));
    expect(rows[1]).toEqual(expect.objectContaining({ offsetRatio: 10 / 160, widthRatio: 150 / 160 }));
  });

  test('places a TTFT tick inside the attempt bar', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    const attempt = span('attempt', '2026-07-12T08:00:00.020Z', '2026-07-12T08:00:00.090Z', 'root');
    const rows = layoutTraceSpans(
      [root, { ...attempt, attributes: { 'aio_proxy.attempt.ttft_ms': 30 } }],
      new Date('2026-07-12T08:00:01.000Z'),
    );

    // attempt 起点 20ms + TTFT 30ms = 整条 trace 的 50ms 处，100ms 跨度 → 0.5。
    expect(rows[1]?.ttftRatio).toBe(0.5);
    expect(rows[0]?.ttftRatio).toBeUndefined();
  });

  test('drops the TTFT tick when the attempt saw more than one response', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    const attempt = span('attempt', '2026-07-12T08:00:00.020Z', '2026-07-12T08:00:00.090Z', 'root');
    const rows = layoutTraceSpans(
      [
        root,
        {
          ...attempt,
          attributes: {
            'aio_proxy.attempt.ttft_ms': 30,
            'aio_proxy.response.transport_observation': 'ambiguous',
          },
        },
      ],
      new Date('2026-07-12T08:00:01.000Z'),
    );

    expect(rows[1]?.ttftRatio).toBeUndefined();
  });

  // 行序不能来自 startedAt 排序：服务端开 attempt 之后紧接着开 prepare，中间没有 await，
  // 两者落在同一毫秒是常态；而它们的 hrtime 没有共同 epoch 锚点，截断后子 span 的毫秒数
  // 甚至可能比父 span 小。两种情况都会把缩进更深的行排到它的父行上面。
  test('puts a parent before its child even when the API order does not', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    // 同一毫秒：API 的 tie-break 是随机 spanId，这里 'a-prepare' 排在 'b-attempt' 前面。
    const attempt = span('b-attempt', '2026-07-12T08:00:00.010Z', '2026-07-12T08:00:00.090Z', 'root');
    const prepare = span('a-prepare', '2026-07-12T08:00:00.010Z', '2026-07-12T08:00:00.020Z', 'b-attempt');
    // 截断造成的真实倒置：子 span 的毫秒数严格小于父 span 的。
    const upstream = span('upstream', '2026-07-12T08:00:00.009Z', '2026-07-12T08:00:00.080Z', 'b-attempt');

    // API 会按 (startedAt, spanId) 给出这个顺序，两个孩子都排在父亲前面。
    const rows = layoutTraceSpans([root, upstream, prepare, attempt], new Date('2026-07-12T08:00:01.000Z'));

    expect(rows.map((row) => row.spanId)).toEqual(['root', 'b-attempt', 'upstream', 'a-prepare']);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2]);
  });

  test('orders siblings by start time', () => {
    const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
    const parse = span('parse', '2026-07-12T08:00:00.010Z', '2026-07-12T08:00:00.020Z', 'root');
    const route = span('route', '2026-07-12T08:00:00.030Z', '2026-07-12T08:00:00.040Z', 'root');
    const order = (children: readonly DashboardTraceSpan[]) =>
      layoutTraceSpans([root, ...children], new Date('2026-07-12T08:00:01.000Z')).map((row) => row.spanId);

    expect(order([parse, route])).toEqual(['root', 'parse', 'route']);
    // Swapping only the timestamps swaps the rows: structure fixes nesting, time orders siblings.
    expect(
      order([
        { ...parse, startedAt: route.startedAt },
        { ...route, startedAt: parse.startedAt },
      ]),
    ).toEqual(['root', 'route', 'parse']);
  });

  // 走在子进程里，因为这条测试守的是「不死循环」：删掉 measureDepths 里那句
  // `seen.add(parent.spanId)`，挂在环下面的 span 会让向上走的循环永不退出。那是同步循环，
  // 同进程的 test timeout 救不了它 —— 事件循环被占住，整个 suite 卡死。子进程 + SIGKILL
  // 看门狗让回归在几秒内变红，而不是把 CI 挂到超时。
  test('terminates on cyclic parents instead of looping, and still renders every row once', () => {
    const moduleUrl = new URL('./trace-layout.ts', import.meta.url).href;
    // `below` / `deeper` 是关键形状：它们自己不在环里，所以 seen 的初始值救不了，
    // 只有把走过的父亲记进 seen 才能停下来。self 和两点环则由初始值兜住。
    const probe = `
      const { layoutTraceSpans } = await import(${JSON.stringify(moduleUrl)});
      const span = (spanId, startedAt, parentSpanId) => ({
        traceId: 'a'.repeat(32), spanId, parentSpanId, name: spanId, kind: 'INTERNAL',
        startedAt, endedAt: startedAt, durationMs: 0, otelStatusCode: 'OK',
        attributes: {}, events: [], links: [],
      });
      const rows = layoutTraceSpans([
        span('cycle-a', '2026-07-12T08:00:00.010Z', 'cycle-b'),
        span('cycle-b', '2026-07-12T08:00:00.020Z', 'cycle-a'),
        span('below', '2026-07-12T08:00:00.030Z', 'cycle-a'),
        span('deeper', '2026-07-12T08:00:00.040Z', 'below'),
        span('self', '2026-07-12T08:00:00.050Z', 'self'),
      ], new Date('2026-07-12T08:00:01.000Z'));
      console.log(JSON.stringify(rows.map((row) => [row.spanId, row.depth])));
    `;

    const probeTimeoutMs = 5_000; // 正常跑完约 0.4s，这里只是看门狗，不是性能断言。
    const result = spawnSync('bun', ['-e', probe], {
      encoding: 'utf8',
      timeout: probeTimeoutMs,
      killSignal: 'SIGKILL',
    });

    // 被看门狗杀掉 == 没能自己停下来。这是这条测试真正守的那件事。
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    // 环里的、环下面的、自己指自己的，全都退化成深度 0 的根，一行不多一行不少。
    expect(JSON.parse(result.stdout)).toEqual([
      ['cycle-a', 0],
      ['cycle-b', 0],
      ['below', 0],
      ['deeper', 0],
      ['self', 0],
    ]);
  });
});

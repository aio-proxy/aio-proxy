import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { formatDuration } from '@/lib/format-duration';

import { traceAttribute } from '../../lib/trace-attribute-names';
import { SpanWaterfall } from './span-waterfall';

const traceId = 'a'.repeat(32);
const rootSpanId = 'b'.repeat(16);
const childSpanId = 'c'.repeat(16);
const spans: readonly DashboardTraceSpan[] = [
  {
    traceId,
    spanId: rootSpanId,
    name: 'aio_proxy.request',
    kind: 'SERVER',
    startedAt: '2026-07-12T08:00:00.000Z',
    endedAt: '2026-07-12T08:00:00.100Z',
    durationMs: 100,
    otelStatusCode: 'OK',
    attributes: {},
    events: [],
    links: [],
  },
  {
    traceId,
    spanId: childSpanId,
    parentSpanId: rootSpanId,
    name: 'aio_proxy.provider.attempt',
    kind: 'CLIENT',
    startedAt: '2026-07-12T08:00:00.010Z',
    endedAt: '2026-07-12T08:00:00.090Z',
    durationMs: 80,
    otelStatusCode: 'ERROR',
    attributes: {},
    events: [],
    links: [],
  },
];

test('keeps server order and selects Span rows through native button activation', () => {
  const onSelect = rs.fn();
  render(
    <SpanWaterfall
      spans={spans}
      selectedSpanId={rootSpanId}
      now={new Date('2026-07-12T08:00:00.100Z')}
      onSelect={onSelect}
    />,
  );

  expect(screen.getAllByTestId('trace-span').map((row) => row.textContent)).toEqual([
    expect.stringContaining('aio_proxy.request'),
    expect.stringContaining('aio_proxy.provider.attempt'),
  ]);
  expect(screen.getByRole('button', { name: /aio_proxy\.request/u })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: /aio_proxy\.provider\.attempt/u }));
  fireEvent.click(screen.getByRole('button', { name: /aio_proxy\.request/u }));

  expect(onSelect).toHaveBeenNthCalledWith(1, childSpanId);
  expect(onSelect).toHaveBeenNthCalledWith(2, rootSpanId);
});

// 树形是这个组件的主可见产物，而它整个不进文本：一棵三层树和一张平表的行 textContent
// 逐字节相同。行序来自 trace-layout 的结构序，缩进只是内联 padding —— 两者都得单独钉。
// fixture 的数组顺序和 startedAt 顺序都**不是**深度优先序（attempt 的存储毫秒比它父
// span 还早，hrtime 截断后真会这样，见 trace-layout 的注释），所以照数组渲染、或在组件
// 里按时间重排，都会把行序打乱；顺序一致的 fixture 对错实现都能过，证明不了任何事。
test('orders rows depth-first and indents by depth, following neither array nor time order', () => {
  const attemptSpanId = 'd'.repeat(16);
  const prepareSpanId = 'e'.repeat(16);
  const tree: readonly DashboardTraceSpan[] = [
    {
      ...spans[1]!,
      spanId: prepareSpanId,
      parentSpanId: attemptSpanId,
      name: 'aio_proxy.request.prepare',
      otelStatusCode: 'OK',
      startedAt: '2026-07-12T08:00:00.005Z',
    },
    { ...spans[0]!, startedAt: '2026-07-12T08:00:00.010Z' },
    { ...spans[1]!, spanId: attemptSpanId, otelStatusCode: 'OK', startedAt: '2026-07-12T08:00:00.000Z' },
  ];

  render(
    <SpanWaterfall
      spans={tree}
      selectedSpanId={undefined}
      now={new Date('2026-07-12T08:00:00.100Z')}
      onSelect={rs.fn()}
    />,
  );

  // 名称格（行的第一格）而不是整行的 textContent：整行还带耗时，而且 `aio_proxy.request`
  // 是 `aio_proxy.request.prepare` 的前缀，用 stringContaining 的话错误的行序照样能过。
  const nameCells = screen.getAllByTestId('trace-span').map((row) => row.firstElementChild as HTMLElement);

  expect(nameCells.map((cell) => cell.textContent)).toEqual([
    'aio_proxy.request',
    'aio_proxy.provider.attempt',
    'aio_proxy.request.prepare',
  ]);
  // 缩进是唯一画出父子关系的东西，而它不产生文本：删掉这行内联样式，上面那条断言全过。
  expect(nameCells.map((cell) => cell.style.paddingInlineStart)).toEqual(['0px', '14px', '28px']);
});

test('filters rows by span name and falls back to an empty message', () => {
  render(
    <SpanWaterfall
      spans={spans}
      selectedSpanId={rootSpanId}
      now={new Date('2026-07-12T08:00:00.100Z')}
      onSelect={rs.fn()}
    />,
  );

  const search = screen.getByTestId('span-search');
  fireEvent.change(search, { target: { value: '  ATTEMPT ' } });

  expect(screen.getAllByTestId('trace-span').map((row) => row.textContent)).toEqual([
    expect.stringContaining('aio_proxy.provider.attempt'),
  ]);

  fireEvent.change(search, { target: { value: 'nothing-matches' } });

  expect(screen.queryAllByTestId('trace-span')).toEqual([]);
  expect(screen.getByText(m['dashboard.traces.span_search_empty']())).toBeTruthy();
});

test('marks a 4xx root Span failed even though its OTel status is UNSET', () => {
  // HTTP 语义约定不许把 SERVER span 的 4xx 记成 ERROR，所以这条 404 的状态是 UNSET。
  // 柱子的颜色测不到，这里锁的是同一处判定给出的读屏文案。
  const rejectedRoot: DashboardTraceSpan = {
    ...spans[0]!,
    otelStatusCode: 'UNSET',
    attributes: { [traceAttribute.httpStatusCode]: 404 },
  };

  render(
    <SpanWaterfall
      spans={[rejectedRoot]}
      selectedSpanId={rootSpanId}
      now={new Date('2026-07-12T08:00:00.100Z')}
      onSelect={rs.fn()}
    />,
  );

  expect(screen.getByTestId('trace-span').textContent).toContain(m['dashboard.traces.failure']());
});

test('scales ruler ticks to the whole trace, not to the root Span duration', () => {
  const lateChild: DashboardTraceSpan = {
    ...spans[1]!,
    // Outlives the 100ms root Span, so the trace spans 160ms in total.
    endedAt: '2026-07-12T08:00:00.160Z',
    durationMs: 150,
  };

  render(
    <SpanWaterfall
      spans={[spans[0]!, lateChild]}
      selectedSpanId={rootSpanId}
      now={new Date('2026-07-12T08:00:00.160Z')}
      onSelect={rs.fn()}
    />,
  );

  expect(screen.getByTestId('waterfall-ruler').textContent).toBe(
    [0, 40, 80, 120, 160].map((ms) => formatDuration(ms)).join(''),
  );
});

test('draws the TTFT tick on an attempt bar that measured first content', () => {
  render(
    <SpanWaterfall
      spans={[spans[0]!, { ...spans[1]!, attributes: { [traceAttribute.attemptTtftMs]: 30 } }]}
      selectedSpanId={undefined}
      now={new Date('2026-07-12T08:00:01.000Z')}
      onSelect={rs.fn()}
    />,
  );

  // 只有 attempt 行画刻度，root 行没有这个属性。
  expect(screen.getAllByTestId('waterfall-ttft-tick')).toHaveLength(1);
});

// 首字是一个时刻，不是一段时间。刻度一旦有了宽度就变成「从 attempt 起点到首字」那根柱子，
// 读者会把它当成一个独立阶段 —— 正是这个设计明确不要的东西。所以定位而不定宽是它的定义性质，
// 光数出一个元素证明不了。
test('positions the TTFT tick without giving it a width that tracks the value', () => {
  const tickFor = (ttftMs: number) => {
    const { unmount } = render(
      <SpanWaterfall
        spans={[spans[0]!, { ...spans[1]!, attributes: { [traceAttribute.attemptTtftMs]: ttftMs } }]}
        selectedSpanId={undefined}
        now={new Date('2026-07-12T08:00:01.000Z')}
        onSelect={rs.fn()}
      />,
    );
    const tick = screen.getByTestId('waterfall-ttft-tick');
    const seen = {
      left: tick.style.left,
      width: tick.style.width,
      ariaHidden: tick.getAttribute('aria-hidden'),
      absolute: tick.classList.contains('absolute'),
    };
    unmount();
    return seen;
  };

  // attempt 起点 10ms + TTFT 30ms，整条 trace 100ms → 40%。
  const early = tickFor(30);
  const late = tickFor(60);

  expect(early.left).toBe('40%');
  expect(late.left).toBe('70%');
  // 位置随 TTFT 走，尺寸不跟着走：宽度完全交给类名里的 1px，没有内联宽度。
  expect(early.width).toBe('');
  expect(late.width).toBe('');
  // `left` 只有在脱离文档流时才定位得动。jsdom 只读内联样式、不算布局，所以少了 absolute
  // 这一条：刻度会退回容器左边缘、对任何 TTFT 都画在同一处，而上面三条断言照样全过。
  expect(early.absolute).toBe(true);
  // 同一个数在详情面板的 TTFT 格子里有文字版，所以不往行的读屏文案里再塞一个数。
  expect(early.ariaHidden).toBe('true');
});

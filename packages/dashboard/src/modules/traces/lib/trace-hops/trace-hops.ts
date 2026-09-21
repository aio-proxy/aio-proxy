import type { DashboardTraceSpan, DashboardTraceSummary, DashboardTraceWireHop } from '@aio-proxy/types';
import { sortBy } from 'es-toolkit/array';

import { isAttemptSpan, traceAttribute } from '../trace-attribute-names';
import { isFailedSpan, isFailedTrace } from '../trace-failure';

/**
 * 四态而不是 failed 布尔：把「不是失败」一律翻译成成功，会让还在跑的和被取消的那几跳画成
 * 绿点、读屏念「成功」—— 取消从失败判定里摘出去之后尤其明显。用的是 `TraceStatus` 同一套
 * 词，所以文案键也是现成的。
 */
export type TraceHopStatus = 'running' | 'cancelled' | 'failure' | 'success';

export interface TraceHopChip {
  readonly id: string;
  readonly label: string;
  readonly kind: 'inbound' | 'attempt';
  readonly attemptIndex: number | undefined;
  readonly status: TraceHopStatus;
}

// 失败判定继续走 isFailedSpan / isFailedTrace（它带着 4xx 那条规则，而 TraceStatus 自己的
// displayStatus 没有），这里只在它之前先把「还在跑」和「已取消」分出来。
const hopStatus = (
  item: Pick<DashboardTraceSpan, 'endedAt' | 'terminationReason'>,
  failed: boolean,
): TraceHopStatus => {
  if (item.endedAt === null) return 'running';
  if (item.terminationReason === 'cancelled') return 'cancelled';
  return failed ? 'failure' : 'success';
};

const numberAttribute = (span: DashboardTraceSpan, key: string): number | undefined => {
  const value = span.attributes[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
};

const stringAttribute = (span: DashboardTraceSpan, key: string): string | undefined => {
  const value = span.attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/**
 * 一条调用链的逐跳列表，主源是 span。抓包只在 `level: debug` 才写，所以降级态下
 * 这排 chip 依然完整 —— 能看到有几跳、哪一跳失败，只是点进去没有正文。
 *
 * 还在跑的调用链例外：子 span 要等结算才落盘，抓包却已经在写上游跳。这时把
 * `wireHops` 里还没有 chip 的 attempt 补进来，否则选择器只剩入站，正文看得到也点不到。
 *
 * hop `id` 和服务端 `wire-log/build-hops.ts` 的口径一致（`inbound` / `attempt-${attemptIndex}`），
 * 抓包结果按它对号入座。`attemptIndex` 是 0 起数的原始值，给人看的序号由调用方加一。
 */
export const toTraceHopChips = (input: {
  readonly spans: readonly DashboardTraceSpan[];
  readonly trace: DashboardTraceSummary;
  readonly wireHops?: readonly DashboardTraceWireHop[];
}): readonly TraceHopChip[] => {
  const { spans, trace, wireHops } = input;
  const attempts = spans.filter(isAttemptSpan);

  const chips: TraceHopChip[] = [
    {
      id: 'inbound',
      label: trace.session?.source ?? trace.inboundProtocol,
      kind: 'inbound',
      attemptIndex: undefined,
      status: hopStatus(trace, isFailedTrace(trace)),
    },
    // index 缺失的 attempt span 排在最后，并退回 spanId 做 id：抓包里对不上号，但仍要看得见这一跳。
    ...sortBy(attempts, [(span) => numberAttribute(span, traceAttribute.attemptIndex) ?? Number.MAX_SAFE_INTEGER]).map(
      (span): TraceHopChip => {
        const attemptIndex = numberAttribute(span, traceAttribute.attemptIndex);
        const id = attemptIndex === undefined ? span.spanId : `attempt-${attemptIndex}`;
        return {
          id,
          label: stringAttribute(span, traceAttribute.providerId) ?? id,
          kind: 'attempt',
          attemptIndex,
          status: hopStatus(span, isFailedSpan(span)),
        };
      },
    ),
  ];
  return trace.endedAt === null ? mergeLiveWireHops(chips, wireHops) : chips;
};

const wireHopStatus = (hop: DashboardTraceWireHop): TraceHopStatus => {
  const responseOutcome = hop.response?.body?.outcome;
  const requestOutcome = hop.request?.body?.outcome;
  if (responseOutcome === 'cancelled' || requestOutcome === 'cancelled') return 'cancelled';
  if (responseOutcome === 'error' || requestOutcome === 'error' || hop.response?.errorType !== undefined) {
    return 'failure';
  }
  const statusCode = hop.response?.statusCode;
  if (statusCode !== undefined && statusCode >= 400) return 'failure';
  // 流式响应一到 headers 就有 `hop.response`，请求 body 也常常已经 complete；
  // 成功只认响应 body 的终态，否则整段 SSE 都会先画成绿点再可能翻成失败。
  if (responseOutcome === 'complete') return 'success';
  return 'running';
};

const mergeLiveWireHops = (
  chips: readonly TraceHopChip[],
  wireHops: readonly DashboardTraceWireHop[] | undefined,
): readonly TraceHopChip[] => {
  if (wireHops === undefined || wireHops.length === 0) return chips;
  const seen = new Set(chips.map((chip) => chip.id));
  const extras = wireHops
    .filter((hop) => hop.kind === 'attempt' && !seen.has(hop.id))
    .map((hop): TraceHopChip => ({
      id: hop.id,
      label: hop.providerId ?? hop.id,
      kind: 'attempt',
      attemptIndex: hop.attemptIndex,
      status: wireHopStatus(hop),
    }));
  if (extras.length === 0) return chips;
  const inbound = chips[0]!;
  return [inbound, ...sortBy([...chips.slice(1), ...extras], [(chip) => chip.attemptIndex ?? Number.MAX_SAFE_INTEGER])];
};

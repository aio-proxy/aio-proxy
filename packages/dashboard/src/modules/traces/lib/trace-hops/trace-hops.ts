import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
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
 * 一条调用链的逐跳列表，只从 span 推导，不看抓包。
 *
 * attempt span 常开，线级抓包只在 `level: debug` 才写，所以降级态下这排 chip 依然是完整的
 * —— 用户能看到有几跳、哪一跳失败，只是点进去没有正文。
 *
 * hop `id` 和服务端 `wire-log/build-hops.ts` 的口径一致（`inbound` / `attempt-${attemptIndex}`），
 * 抓包结果按它对号入座。`attemptIndex` 是 0 起数的原始值，给人看的序号由调用方加一。
 */
export const toTraceHopChips = (input: {
  readonly spans: readonly DashboardTraceSpan[];
  readonly trace: DashboardTraceSummary;
}): readonly TraceHopChip[] => {
  const { spans, trace } = input;
  const attempts = spans.filter(isAttemptSpan);

  return [
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
};

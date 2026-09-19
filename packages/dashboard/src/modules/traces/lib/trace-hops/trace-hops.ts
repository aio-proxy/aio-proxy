import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { sortBy } from 'es-toolkit/array';

import { traceAttribute, traceSpanName } from '../trace-attribute-names';
import { isFailedSpan, isFailedTrace } from '../trace-failure';

export interface TraceHopChip {
  readonly id: string;
  readonly label: string;
  readonly kind: 'inbound' | 'attempt';
  readonly attemptIndex: number | undefined;
  readonly failed: boolean;
}

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
  const attempts = spans.filter((span) => span.name === traceSpanName.attempt);

  return [
    {
      id: 'inbound',
      label: trace.session?.source ?? trace.inboundProtocol,
      kind: 'inbound',
      attemptIndex: undefined,
      failed: isFailedTrace(trace),
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
          failed: isFailedSpan(span),
        };
      },
    ),
  ];
};

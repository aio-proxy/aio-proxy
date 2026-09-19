import { and, eq, gte, isNotNull, lte, ne, type SQL } from 'drizzle-orm';

import { traceSpan } from '../schema';
import type { TracesQuery } from './types';

export type TraceFilters = Omit<TracesQuery, 'pageSize' | 'cursor'>;

// 链路上没有任何地方把根 span 设成 OTel OK —— 成功的调用链是「结束了、且不是 ERROR」，
// 还在跑的两边都不算。判定只写在这一处：图上的计数和点掉图例后的筛选必须框住同一批
// 调用链，各写一遍就是 0 成功那个 bug 的来路。
export const SUCCEEDED = and(isNotNull(traceSpan.endedAt), ne(traceSpan.statusCode, 2)) as SQL;
export const FAILED = eq(traceSpan.statusCode, 2);

export function traceFilterConditions(filters: TraceFilters): (SQL | undefined)[] {
  return [
    filters.startedAfter === undefined ? undefined : gte(traceSpan.startedAt, filters.startedAfter),
    filters.startedBefore === undefined ? undefined : lte(traceSpan.startedAt, filters.startedBefore),
    filters.traceId === undefined ? undefined : eq(traceSpan.traceId, filters.traceId),
    filters.requestId === undefined ? undefined : eq(traceSpan.requestId, filters.requestId),
    filters.sessionSource === undefined ? undefined : eq(traceSpan.sessionSource, filters.sessionSource),
    filters.sessionId === undefined ? undefined : eq(traceSpan.sessionId, filters.sessionId),
    filters.outcome === undefined ? undefined : filters.outcome === 'success' ? SUCCEEDED : FAILED,
    filters.otelStatusCode === undefined
      ? undefined
      : eq(traceSpan.statusCode, statusCodeFromOtel(filters.otelStatusCode)),
    filters.terminationReason === undefined ? undefined : eq(traceSpan.terminationReason, filters.terminationReason),
    filters.inboundProtocol === undefined ? undefined : eq(traceSpan.inboundProtocol, filters.inboundProtocol),
    filters.requestedModelId === undefined ? undefined : eq(traceSpan.requestedModelId, filters.requestedModelId),
    filters.finalProviderId === undefined ? undefined : eq(traceSpan.finalProviderId, filters.finalProviderId),
    filters.finalModelId === undefined ? undefined : eq(traceSpan.finalModelId, filters.finalModelId),
    filters.finalHttpStatus === undefined ? undefined : eq(traceSpan.finalHttpStatus, filters.finalHttpStatus),
  ];
}

export function statusCodeFromOtel(otel: 'UNSET' | 'OK' | 'ERROR'): number {
  if (otel === 'OK') return 1;
  if (otel === 'ERROR') return 2;
  return 0;
}

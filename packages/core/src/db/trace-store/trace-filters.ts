import { and, eq, gte, isNotNull, isNull, lte, ne, or, type SQL } from 'drizzle-orm';

import { traceSpan } from '../schema';
import type { TracesQuery } from './types';

export type TraceFilters = Omit<TracesQuery, 'pageSize' | 'cursor'>;

// 链路上没有任何地方把根 span 设成 OTel OK —— 成功的调用链是「结束了、且不是 ERROR」，
// 还在跑的两边都不算。判定只写在这一处：图上的计数和点掉图例后的筛选必须框住同一批
// 调用链，各写一遍就是 0 成功那个 bug 的来路。
//
// 取消也不算失败。`request-trace-recorder/completion.ts` 给取消的请求同样设 ERROR，
// 只靠 statusCode 判的话，表格里标「已取消」的那些会被计进失败柱、点「失败」也会把它们
// 捞出来 —— 图和表对同一条调用链给两个说法。取消跟「还在跑」一样两边都不计，要单独看
// 它走 `terminationReason` 筛选（下面那条）。
//
// terminationReason 可能为 NULL（老数据，以及任何设了 ERROR 却没写原因的路径），而 SQL 里
// `NULL <> 'cancelled'` 求值为 NULL、在 WHERE 里当假 —— 少了 isNull 这一半，那些行会从
// 失败里整批消失。
const NOT_CANCELLED = or(isNull(traceSpan.terminationReason), ne(traceSpan.terminationReason, 'cancelled')) as SQL;
export const SUCCEEDED = and(isNotNull(traceSpan.endedAt), ne(traceSpan.statusCode, 2)) as SQL;
export const FAILED = and(eq(traceSpan.statusCode, 2), NOT_CANCELLED) as SQL;

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

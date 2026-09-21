import { and, eq, gte, isNotNull, isNull, lte, ne, not, or, type SQL } from 'drizzle-orm';

import { traceSpan } from '../schema';
import type { TracesQuery } from './types';

export type TraceFilters = Omit<TracesQuery, 'pageSize' | 'cursor'>;

// 链路上没有任何地方把根 span 设成 OTel OK —— 成功的调用链是「结束了、且不算失败」，
// 还在跑的两边都不算。判定只写在这一处：图上的计数和点掉图例后的筛选必须框住同一批
// 调用链，各写一遍就是 0 成功那个 bug 的来路。
//
// 4xx 得看 finalHttpStatus 而不是 statusCode：HTTP 语义约定不许把客户端错误记成 span
// ERROR（root SERVER span 上的 4xx 保持 UNSET），可它对运维仍然是一条失败的调用链。
// finalHttpStatus 可空 —— 还在跑的、cancelled 的、拿不到状态码的内部失败都是 NULL。
// 少了 IS NOT NULL 这一半，ERRORED 对这些行算出来是 NULL，NOT NULL 还是 NULL，它们
// 就会从成功和失败两个桶里一起消失，图上凭空少几条还不报错。
const ERRORED = or(
  eq(traceSpan.statusCode, 2),
  and(isNotNull(traceSpan.finalHttpStatus), gte(traceSpan.finalHttpStatus, 400)),
) as SQL;

// 取消不算失败，也不算成功。`request-trace-recorder/completion.ts` 按 HTTP 语义约定
// 只写 terminationReason，根 span 保持 UNSET。不在 SUCCEEDED 里减掉它的话，结束了
// 又不是错误的取消会进成功柱、点「成功」也会捞出来，还能进延迟分位。FAILED 同样要减：
// 老数据里取消的根 span 仍可能是 ERROR。
//
// terminationReason 可能为 NULL（老数据，以及任何设了 ERROR 却没写原因的路径），而 SQL 里
// `NULL <> 'cancelled'` 求值为 NULL、在 WHERE 里当假 —— 少了 isNull 这一半，那些行会从
// 失败里整批消失。
const NOT_CANCELLED = or(isNull(traceSpan.terminationReason), ne(traceSpan.terminationReason, 'cancelled')) as SQL;

export const FAILED = and(ERRORED, NOT_CANCELLED) as SQL;
export const SUCCEEDED = and(isNotNull(traceSpan.endedAt), not(ERRORED), NOT_CANCELLED) as SQL;

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

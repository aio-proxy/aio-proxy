import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';

import { traceAttribute } from '../trace-attribute-names';

// 一条调用链（或其中一跳）算不算失败，前端只在这一处判断。
//
// 光看 OTel status 是不够的：HTTP 语义约定不许把 SERVER span 的 4xx 记成 ERROR，所以
// 一条 404 / 413 的 root span 状态是 UNSET。服务端的成败判定
//（`packages/core/src/db/trace-store/trace-filters.ts` 的 FAILED）用的就是下面这条规则，
// 两边必须一致 —— 否则桶状图和列表说失败，而瀑布图画一根绿柱子。
// 取消不算失败。取消的根 span 也是 ERROR，但 `TraceStatus` 把它渲染成中性的「已取消」，
// 服务端的 FAILED 也显式排除了它 —— 少了这一条，取消的调用链在瀑布图上是一根红柱子、
// 读屏还念「失败」，而同一条链在列表和分桶图里既不算成功也不算失败。
const isFailed = (
  otelStatusCode: DashboardTraceSpan['otelStatusCode'],
  httpStatus: number | undefined,
  terminationReason: DashboardTraceSpan['terminationReason'],
): boolean =>
  terminationReason !== 'cancelled' && (otelStatusCode === 'ERROR' || (httpStatus !== undefined && httpStatus >= 400));

const numberAttribute = (attributes: DashboardTraceSpan['attributes'], key: string): number | undefined => {
  const value = attributes[key];
  return typeof value === 'number' ? value : undefined;
};

// 老 key 的兜底和 span-metrics 那条是同一条，理由也一样：库里现存的 span 全是
// `http.status_code` 写的，不迁移数据。少了它，历史 trace 的 4xx/5xx 读回来是
// 「没有状态码」，而它们的 OTel status 按语义约定是 UNSET —— 于是瀑布图在一条失败
// 请求下面画一根绿柱子，正是上面那条服务端/前端必须一致的规则被悄悄破掉的样子。
const spanHttpStatus = (attributes: DashboardTraceSpan['attributes']): number | undefined =>
  numberAttribute(attributes, traceAttribute.httpStatusCode) ??
  numberAttribute(attributes, traceAttribute.legacyHttpStatusCode);

/** 单个 span 失败与否。状态码挂在 span 属性上，只有 root 和 attempt span 会记。 */
export const isFailedSpan = (
  span: Pick<DashboardTraceSpan, 'otelStatusCode' | 'attributes' | 'terminationReason'>,
): boolean => isFailed(span.otelStatusCode, spanHttpStatus(span.attributes), span.terminationReason);

/** 整条调用链失败与否。列表行只有汇总，状态码是 `finalHttpStatus` 那一列。 */
export const isFailedTrace = (
  trace: Pick<DashboardTraceSummary, 'otelStatusCode' | 'finalHttpStatus' | 'terminationReason'>,
): boolean => isFailed(trace.otelStatusCode, trace.finalHttpStatus, trace.terminationReason);

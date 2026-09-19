import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';

import { traceAttribute } from '../trace-attribute-names';

// 一条调用链（或其中一跳）算不算失败，前端只在这一处判断。
//
// 光看 OTel status 是不够的：HTTP 语义约定不许把 SERVER span 的 4xx 记成 ERROR，所以
// 一条 404 / 413 的 root span 状态是 UNSET。服务端的成败判定
//（`packages/core/src/db/trace-store/trace-filters.ts` 的 FAILED）用的就是下面这条规则，
// 两边必须一致 —— 否则桶状图和列表说失败，而瀑布图画一根绿柱子。
const isFailed = (otelStatusCode: DashboardTraceSpan['otelStatusCode'], httpStatus: number | undefined): boolean =>
  otelStatusCode === 'ERROR' || (httpStatus !== undefined && httpStatus >= 400);

const spanHttpStatus = (attributes: DashboardTraceSpan['attributes']): number | undefined => {
  const value = attributes[traceAttribute.httpStatusCode];
  return typeof value === 'number' ? value : undefined;
};

/** 单个 span 失败与否。状态码挂在 span 属性上，只有 root 和 attempt span 会记。 */
export const isFailedSpan = (span: Pick<DashboardTraceSpan, 'otelStatusCode' | 'attributes'>): boolean =>
  isFailed(span.otelStatusCode, spanHttpStatus(span.attributes));

/** 整条调用链失败与否。列表行只有汇总，状态码是 `finalHttpStatus` 那一列。 */
export const isFailedTrace = (trace: Pick<DashboardTraceSummary, 'otelStatusCode' | 'finalHttpStatus'>): boolean =>
  isFailed(trace.otelStatusCode, trace.finalHttpStatus);

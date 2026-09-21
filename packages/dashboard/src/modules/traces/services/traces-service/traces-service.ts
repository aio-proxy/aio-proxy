import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { omit } from 'es-toolkit/object';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

import type { TraceSearch } from '../../lib/trace-search';

type DashboardTracesResponse = InferResponseType<typeof dashboardClient.dashboard.api.traces.$get, 200>;
type DashboardTraceResponse = InferResponseType<(typeof dashboardClient.dashboard.api.traces)[':traceId']['$get'], 200>;
type DashboardTraceSummaryResponse = InferResponseType<typeof dashboardClient.dashboard.api.traces.summary.$get, 200>;
type DashboardTracePercentileResponse = InferResponseType<
  (typeof dashboardClient.dashboard.api.traces)[':traceId']['percentile']['$get'],
  200
>;
type DashboardTraceWireResponse = InferResponseType<
  (typeof dashboardClient.dashboard.api.traces)[':traceId']['wire']['$get'],
  200
>;

export class DashboardTracesRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard traces request failed with status ${status}`);
    this.name = 'DashboardTracesRequestError';
  }
}

export const tracesQueryOptions = (search: TraceSearch, autoRefresh: boolean) =>
  queryOptions({
    queryKey: queryKeys.traces(search),
    queryFn: () => getTraces(search),
    refetchInterval: autoRefresh && search.pageToken === undefined ? 5_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

export const traceQueryOptions = (traceId: string) =>
  queryOptions({
    queryKey: queryKeys.trace(traceId),
    queryFn: () => getTrace(traceId),
    // 打开还在跑的详情时，endedAt 要跟着刷，请求/响应那两页才知道何时停扫日志。
    refetchInterval: (query) => (query.state.data?.trace.endedAt === null ? 5_000 : false),
    refetchIntervalInBackground: false,
  });

// 一小时窗口的聚合，逐秒刷新没有意义：一分钟内复用缓存，翻回这一页不再打一次请求。
export const tracePercentileQueryOptions = (traceId: string) =>
  queryOptions({
    queryKey: queryKeys.tracePercentile(traceId),
    queryFn: () => getTracePercentile(traceId),
    staleTime: 60_000,
  });

const WIRE_BODY_TERMINAL = new Set(['complete', 'cancelled', 'error']);

const hopHasUnterminatedBody = (hop: DashboardTraceWireResponse['hops'][number]): boolean => {
  if (hop.request?.body !== undefined && !WIRE_BODY_TERMINAL.has(hop.request.body.outcome ?? '')) return true;
  if (hop.response === undefined) return false;
  // fetch 在出 Response 之前抛错时只有 errorType，不会再有 body 终态。
  if (hop.response.errorType !== undefined) return false;
  return !WIRE_BODY_TERMINAL.has(hop.response.body?.outcome ?? '');
};

const shouldPollWireCapture = (settled: boolean, data: DashboardTraceWireResponse | undefined): boolean => {
  if (!settled) return true;
  return data !== undefined && data.available && data.hops.some(hopHasUnterminatedBody);
};

// 还在跑的调用链会继续往日志里写，跟列表一样 5 秒拉一次。
// 根 span 先结算、响应 body 后被消费时（raw 失败路径），endedAt 已经有了，
// 但 hop 上还没有 body 终态 —— 这时不能按「调用结束」把半截抓包冻住。
export const traceWireQueryOptions = (traceId: string, settled: boolean) =>
  queryOptions({
    queryKey: queryKeys.traceWire(traceId),
    queryFn: () => getTraceWire(traceId),
    staleTime: settled ? Number.POSITIVE_INFINITY : 0,
    refetchInterval: (query) => (shouldPollWireCapture(settled, query.state.data) ? 5_000 : false),
    refetchIntervalInBackground: false,
  });

const toSummaryFilters = (search: TraceSearch) => omit(search, ['pageSize', 'pageToken']);

// The list and the chart must filter on exactly the same thing, so both routes spread this one
// object: a 12th filter field added to only one of them reads as "the table filtered, the chart
// did not". Pagination and the date bounds stay at the call sites, where the two routes differ.
const toFilterQuery = (search: TraceSearch) => ({
  ...(search.traceId === undefined ? {} : { traceId: search.traceId }),
  ...(search.requestId === undefined ? {} : { requestId: search.requestId }),
  ...(search.sessionSource === undefined ? {} : { sessionSource: search.sessionSource }),
  ...(search.sessionId === undefined ? {} : { sessionId: search.sessionId }),
  ...(search.otelStatusCode === undefined ? {} : { otelStatusCode: search.otelStatusCode }),
  ...(search.outcome === undefined ? {} : { outcome: search.outcome }),
  ...(search.terminationReason === undefined ? {} : { terminationReason: search.terminationReason }),
  ...(search.inboundProtocol === undefined ? {} : { inboundProtocol: search.inboundProtocol }),
  ...(search.requestedModelId === undefined ? {} : { requestedModelId: search.requestedModelId }),
  ...(search.finalProviderId === undefined ? {} : { finalProviderId: search.finalProviderId }),
  ...(search.finalModelId === undefined ? {} : { finalModelId: search.finalModelId }),
  ...(search.finalHttpStatus === undefined ? {} : { finalHttpStatus: search.finalHttpStatus }),
});

// 轮询条件和 `tracesQueryOptions` 保持一致：图和表要么一起动，要么一起停。
export const traceSummaryQueryOptions = (search: TraceSearch, autoRefresh: boolean) =>
  queryOptions({
    queryKey: queryKeys.tracesSummary(toSummaryFilters(search)),
    queryFn: () => getTraceSummary(search),
    refetchInterval: autoRefresh && search.pageToken === undefined ? 5_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

export const getTraces = async (search: TraceSearch): Promise<DashboardTracesResponse> => {
  const response = await dashboardClient.dashboard.api.traces.$get({
    query: {
      pageSize: String(search.pageSize),
      ...(search.pageToken === undefined ? {} : { pageToken: search.pageToken }),
      // Hono exposes the validator's transformed Date type, but its HTTP client must send the ISO input.
      startedAfter: search.startedAfter as unknown as Date,
      startedBefore: search.startedBefore as unknown as Date,
      ...toFilterQuery(search),
    },
  });
  if (!response.ok) throw new DashboardTracesRequestError(response.status);
  return response.json();
};

export const getTrace = async (traceId: string): Promise<DashboardTraceResponse> => {
  const response = await dashboardClient.dashboard.api.traces[':traceId'].$get({ param: { traceId } });
  if (!response.ok) throw new DashboardTracesRequestError(response.status);
  return response.json();
};

export const getTracePercentile = async (traceId: string): Promise<DashboardTracePercentileResponse> => {
  const response = await dashboardClient.dashboard.api.traces[':traceId'].percentile.$get({ param: { traceId } });
  if (!response.ok) throw new DashboardTracesRequestError(response.status);
  return response.json();
};

export const getTraceWire = async (traceId: string): Promise<DashboardTraceWireResponse> => {
  const response = await dashboardClient.dashboard.api.traces[':traceId'].wire.$get({ param: { traceId } });
  if (!response.ok) throw new DashboardTracesRequestError(response.status);
  return response.json();
};

export const getTraceSummary = async (search: TraceSearch): Promise<DashboardTraceSummaryResponse> => {
  const response = await dashboardClient.dashboard.api.traces.summary.$get({
    query: {
      // 摘要里这两个是必填，Hono 客户端直接收 ISO 串（列表路由的可选版本才暴露 transform 后的 Date）。
      startedAfter: search.startedAfter,
      startedBefore: search.startedBefore,
      ...toFilterQuery(search),
    },
  });
  if (!response.ok) throw new DashboardTracesRequestError(response.status);
  return response.json();
};

export type TracesData = Awaited<ReturnType<typeof getTraces>>;
export type TraceData = Awaited<ReturnType<typeof getTrace>>;
export type TraceSummaryData = Awaited<ReturnType<typeof getTraceSummary>>;

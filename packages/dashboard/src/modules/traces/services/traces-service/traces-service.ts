import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { omit } from 'es-toolkit/object';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

import type { TraceSearch } from '../../lib/trace-search';

type DashboardTracesResponse = InferResponseType<typeof dashboardClient.dashboard.api.traces.$get, 200>;
type DashboardTraceResponse = InferResponseType<(typeof dashboardClient.dashboard.api.traces)[':traceId']['$get'], 200>;
type DashboardTraceSummaryResponse = InferResponseType<typeof dashboardClient.dashboard.api.traces.summary.$get, 200>;

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
  });

const toSummaryFilters = (search: TraceSearch) => omit(search, ['pageSize', 'pageToken']);

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

export const getTraceSummary = async (search: TraceSearch): Promise<DashboardTraceSummaryResponse> => {
  const response = await dashboardClient.dashboard.api.traces.summary.$get({
    query: {
      // 摘要里这两个是必填，Hono 客户端直接收 ISO 串（列表路由的可选版本才暴露 transform 后的 Date）。
      startedAfter: search.startedAfter,
      startedBefore: search.startedBefore,
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
    },
  });
  if (!response.ok) throw new DashboardTracesRequestError(response.status);
  return response.json();
};

export type TracesData = Awaited<ReturnType<typeof getTraces>>;
export type TraceData = Awaited<ReturnType<typeof getTrace>>;
export type TraceSummaryData = Awaited<ReturnType<typeof getTraceSummary>>;

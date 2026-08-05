import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';

import type { TraceSearch } from '../../lib/trace-search';

type DashboardTracesResponse = InferResponseType<typeof dashboardClient.dashboard.api.traces.$get, 200>;
type DashboardTraceResponse = InferResponseType<(typeof dashboardClient.dashboard.api.traces)[':traceId']['$get'], 200>;

export class DashboardTracesRequestError extends Error {
  constructor(readonly status: number) {
    super(`Dashboard traces request failed with status ${status}`);
    this.name = 'DashboardTracesRequestError';
  }
}

export const tracesQueryOptions = (search: TraceSearch, autoRefresh: boolean) =>
  queryOptions({
    queryKey: ['dashboard', 'traces', search],
    queryFn: () => getTraces(search),
    refetchInterval: autoRefresh && search.pageToken === undefined ? 5_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

export const traceQueryOptions = (traceId: string) =>
  queryOptions({
    queryKey: ['dashboard', 'traces', traceId],
    queryFn: () => getTrace(traceId),
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

export type TracesData = Awaited<ReturnType<typeof getTraces>>;
export type TraceData = Awaited<ReturnType<typeof getTrace>>;

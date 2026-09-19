import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { keepPreviousData } from '@tanstack/react-query';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import {
  DashboardTracesRequestError,
  getTrace,
  getTracePercentile,
  getTraces,
  getTraceSummary,
  getTraceWire,
  tracePercentileQueryOptions,
  traceQueryOptions,
  tracesQueryOptions,
  traceSummaryQueryOptions,
  traceWireQueryOptions,
} from './traces-service';

const mocks = rs.hoisted(() => ({
  list: rs.fn(),
  detail: rs.fn(),
  summary: rs.fn(),
  percentile: rs.fn(),
  wire: rs.fn(),
}));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: {
      api: {
        traces: {
          $get: mocks.list,
          summary: { $get: mocks.summary },
          ':traceId': { $get: mocks.detail, percentile: { $get: mocks.percentile }, wire: { $get: mocks.wire } },
        },
      },
    },
  },
}));

const traceId = 'a'.repeat(32);
const listBody = { items: [], nextPageToken: 'next-page-token' };
const detailBody = {
  trace: {
    traceId,
    rootSpanId: 'b'.repeat(16),
    requestId: 'request-a',
    startedAt: '2026-07-12T08:00:00.000Z',
    endedAt: null,
    durationMs: 100,
    otelStatusCode: 'UNSET',
    inboundProtocol: 'openai-response',
  },
  spans: [],
};
const summaryBody = {
  bucket: '5m',
  buckets: [{ at: '2026-07-12T08:00:00.000Z', success: 3, error: 1 }],
  totals: { success: 3, error: 1 },
};
const percentileBody = { sampleSize: 12, percentile: 87, modelId: 'gpt-5' };
const wireBody = { available: true, hops: [] };

describe('trace service', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.detail.mockReset();
    mocks.summary.mockReset();
    mocks.list.mockResolvedValue(new Response(JSON.stringify(listBody), { status: 200 }));
    mocks.detail.mockResolvedValue(new Response(JSON.stringify(detailBody), { status: 200 }));
    mocks.summary.mockResolvedValue(new Response(JSON.stringify(summaryBody), { status: 200 }));
    mocks.percentile.mockReset();
    mocks.wire.mockReset();
    mocks.percentile.mockResolvedValue(new Response(JSON.stringify(percentileBody), { status: 200 }));
    mocks.wire.mockResolvedValue(new Response(JSON.stringify(wireBody), { status: 200 }));
  });

  test('forwards the page token, date bounds, and every active filter to the typed list route', async () => {
    const search = {
      ...createDefaultTraceSearch(new Date('2026-07-12T12:00:00.000Z')),
      pageSize: 20 as const,
      pageToken: 'next-page-token',
      traceId,
      requestId: 'request-a',
      sessionSource: 'openai-prompt-cache',
      sessionId: 'cache-a',
      otelStatusCode: 'ERROR' as const,
      outcome: 'error' as const,
      terminationReason: 'cancelled' as const,
      inboundProtocol: 'openai-response',
      requestedModelId: 'gpt-5',
      finalProviderId: 'provider-a',
      finalModelId: 'gpt-5.1',
      finalHttpStatus: 503,
    };

    await getTraces(search);

    expect(mocks.list).toHaveBeenCalledWith({
      query: {
        pageSize: '20',
        pageToken: 'next-page-token',
        startedAfter: search.startedAfter,
        startedBefore: search.startedBefore,
        traceId,
        requestId: 'request-a',
        sessionSource: 'openai-prompt-cache',
        sessionId: 'cache-a',
        otelStatusCode: 'ERROR',
        outcome: 'error',
        terminationReason: 'cancelled',
        inboundProtocol: 'openai-response',
        requestedModelId: 'gpt-5',
        finalProviderId: 'provider-a',
        finalModelId: 'gpt-5.1',
        finalHttpStatus: 503,
      },
    });
  });

  test('loads one trace from the typed detail route', async () => {
    await expect(getTrace(traceId)).resolves.toEqual(detailBody);
    expect(mocks.detail).toHaveBeenCalledWith({ param: { traceId } });
  });

  test('keeps the previous page and polls only searches without a page token', () => {
    const search = createDefaultTraceSearch(new Date('2026-07-12T12:00:00.000Z'));

    expect(tracesQueryOptions(search, true).queryKey).toEqual(['dashboard', 'traces', search]);
    expect(tracesQueryOptions(search, true).placeholderData).toBe(keepPreviousData);
    expect(tracesQueryOptions(search, true).refetchInterval).toBe(5_000);
    expect(tracesQueryOptions({ ...search, pageToken: 'next-page-token' }, true).refetchInterval).toBe(false);
    expect(tracesQueryOptions(search, false).refetchInterval).toBe(false);
    expect(traceQueryOptions(traceId).queryKey).toEqual(['dashboard', 'traces', traceId]);
    expect(traceQueryOptions(traceId).refetchInterval).toBeUndefined();
  });

  test('sends the same filters as the list route to the summary route, without pagination', async () => {
    const search = {
      ...createDefaultTraceSearch(new Date('2026-07-12T12:00:00.000Z')),
      pageSize: 20 as const,
      pageToken: 'next-page-token',
      traceId,
      requestId: 'request-a',
      sessionSource: 'openai-prompt-cache',
      sessionId: 'cache-a',
      otelStatusCode: 'ERROR' as const,
      outcome: 'error' as const,
      terminationReason: 'cancelled' as const,
      inboundProtocol: 'openai-response',
      requestedModelId: 'gpt-5',
      finalProviderId: 'provider-a',
      finalModelId: 'gpt-5.1',
      finalHttpStatus: 503,
    };

    await expect(getTraceSummary(search)).resolves.toEqual(summaryBody);

    expect(mocks.summary).toHaveBeenCalledWith({
      query: {
        startedAfter: search.startedAfter,
        startedBefore: search.startedBefore,
        traceId,
        requestId: 'request-a',
        sessionSource: 'openai-prompt-cache',
        sessionId: 'cache-a',
        otelStatusCode: 'ERROR',
        outcome: 'error',
        terminationReason: 'cancelled',
        inboundProtocol: 'openai-response',
        requestedModelId: 'gpt-5',
        finalProviderId: 'provider-a',
        finalModelId: 'gpt-5.1',
        finalHttpStatus: 503,
      },
    });
  });

  test('keys the summary without pagination so paging does not refetch the chart', () => {
    const search = createDefaultTraceSearch(new Date('2026-07-12T12:00:00.000Z'));
    const paged = { ...search, pageSize: 20 as const, pageToken: 'next-page-token' };

    expect(traceSummaryQueryOptions(search, true).queryKey).toEqual(traceSummaryQueryOptions(paged, true).queryKey);
    expect(traceSummaryQueryOptions(search, true).queryKey).not.toEqual(
      traceSummaryQueryOptions({ ...search, finalProviderId: 'provider-a' }, true).queryKey,
    );
    expect(traceSummaryQueryOptions(search, true).refetchInterval).toBe(5_000);
    expect(traceSummaryQueryOptions(paged, true).refetchInterval).toBe(false);
    expect(traceSummaryQueryOptions(search, false).refetchInterval).toBe(false);
  });

  test('reads the capture and the percentile from their own routes, under their own cache keys', async () => {
    await expect(getTraceWire(traceId)).resolves.toEqual(wireBody);
    await expect(getTracePercentile(traceId)).resolves.toEqual(percentileBody);
    expect(mocks.wire).toHaveBeenCalledWith({ param: { traceId } });
    expect(mocks.percentile).toHaveBeenCalledWith({ param: { traceId } });

    // Sharing one key would serve each panel the other's response shape.
    expect(traceWireQueryOptions(traceId).queryKey).not.toEqual(tracePercentileQueryOptions(traceId).queryKey);
  });

  test.each([
    ['list', 503],
    ['detail', 404],
  ] as const)('throws a typed status error for a non-2xx %s response', async (kind, status) => {
    const method = kind === 'list' ? mocks.list : mocks.detail;
    method.mockResolvedValueOnce(new Response(null, { status }));

    const request = kind === 'list' ? getTraces(createDefaultTraceSearch()) : getTrace(traceId);

    await expect(request).rejects.toEqual(expect.objectContaining({ name: 'DashboardTracesRequestError', status }));
    await expect(request).rejects.toBeInstanceOf(DashboardTracesRequestError);
  });
});

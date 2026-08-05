import { beforeEach, describe, expect, rs, test } from '@rstest/core';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import {
  DashboardTracesRequestError,
  getTrace,
  getTraces,
  traceQueryOptions,
  tracesQueryOptions,
} from './traces-service';

const mocks = rs.hoisted(() => ({ list: rs.fn(), detail: rs.fn() }));

rs.mock('@/lib/dashboard-client', () => ({
  dashboardClient: {
    dashboard: {
      api: {
        traces: {
          $get: mocks.list,
          ':traceId': { $get: mocks.detail },
        },
      },
    },
  },
}));

const traceId = 'a'.repeat(32);
const listBody = { items: [], page: 1, pageSize: 50, total: 0, pageCount: 0 };
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

describe('trace service', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.detail.mockReset();
    mocks.list.mockResolvedValue(new Response(JSON.stringify(listBody), { status: 200 }));
    mocks.detail.mockResolvedValue(new Response(JSON.stringify(detailBody), { status: 200 }));
  });

  test('sends start-time bounds and every active trace filter to the typed list route', async () => {
    const search = {
      ...createDefaultTraceSearch(new Date('2026-07-12T12:00:00.000Z')),
      page: 2,
      pageSize: 20 as const,
      traceId,
      requestId: 'request-a',
      sessionSource: 'openai-prompt-cache',
      sessionId: 'cache-a',
      otelStatusCode: 'ERROR' as const,
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
        page: '2',
        pageSize: '20',
        startedAfter: search.startedAfter,
        startedBefore: search.startedBefore,
        traceId,
        requestId: 'request-a',
        sessionSource: 'openai-prompt-cache',
        sessionId: 'cache-a',
        otelStatusCode: 'ERROR',
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

  test('polls the first list page every five seconds but never polls detail', () => {
    const search = createDefaultTraceSearch(new Date('2026-07-12T12:00:00.000Z'));

    expect(tracesQueryOptions(search, true).queryKey).toEqual(['dashboard', 'traces', search]);
    expect(tracesQueryOptions(search, true).refetchInterval).toBe(5_000);
    expect(tracesQueryOptions({ ...search, page: 2 }, true).refetchInterval).toBe(false);
    expect(tracesQueryOptions(search, false).refetchInterval).toBe(false);
    expect(traceQueryOptions(traceId).queryKey).toEqual(['dashboard', 'traces', traceId]);
    expect(traceQueryOptions(traceId).refetchInterval).toBeUndefined();
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

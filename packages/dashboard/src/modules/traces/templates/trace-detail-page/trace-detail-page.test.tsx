import type { DashboardTraceDetail } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { DashboardTracesRequestError } from '../../services/traces-service';
import { TraceDetailPage } from './trace-detail-page';

const mocks = rs.hoisted(() => ({ mode: 'terminal', refetch: rs.fn() }));
const traceId = 'a'.repeat(32);
const detail: DashboardTraceDetail = {
  trace: {
    traceId,
    rootSpanId: 'b'.repeat(16),
    requestId: 'request-a',
    startedAt: '2026-07-12T08:00:00.000Z',
    endedAt: '2026-07-12T08:00:00.125Z',
    durationMs: 125,
    otelStatusCode: 'ERROR',
    terminationReason: 'failure',
    errorType: 'upstream_error',
    errorCode: 'provider_unavailable',
    session: { source: 'openai-prompt-cache', id: 'cache-a' },
    sessionResolvedBy: 'openai-prompt-cache',
    inboundProtocol: 'openai-response',
    requestedModelId: 'gpt-5',
    finalProviderId: 'provider-a',
    finalModelId: 'gpt-5.1',
    finalHttpStatus: 503,
    usage: { providerId: 'provider-a', modelId: 'gpt-5.1', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
  spans: [
    {
      traceId,
      spanId: 'b'.repeat(16),
      name: 'aio_proxy.request',
      kind: 'SERVER',
      startedAt: '2026-07-12T08:00:00.000Z',
      endedAt: '2026-07-12T08:00:00.125Z',
      durationMs: 125,
      otelStatusCode: 'ERROR',
      terminationReason: 'failure',
      attributes: {},
      events: [],
      links: [],
    },
    {
      traceId,
      spanId: 'c'.repeat(16),
      parentSpanId: 'b'.repeat(16),
      name: 'aio_proxy.provider.attempt',
      kind: 'CLIENT',
      startedAt: '2026-07-12T08:00:00.010Z',
      endedAt: '2026-07-12T08:00:00.110Z',
      durationMs: 100,
      otelStatusCode: 'ERROR',
      terminationReason: 'failure',
      attributes: { 'aio_proxy.provider.id': 'provider-a' },
      events: [],
      links: [],
    },
    {
      traceId,
      spanId: 'd'.repeat(16),
      parentSpanId: 'c'.repeat(16),
      name: 'gen_ai.inference',
      kind: 'CLIENT',
      startedAt: '2026-07-12T08:00:00.020Z',
      endedAt: '2026-07-12T08:00:00.100Z',
      durationMs: 80,
      otelStatusCode: 'OK',
      attributes: { 'gen_ai.response.model': 'gpt-5.1' },
      events: [],
      links: [],
    },
  ],
};

rs.mock('../../hooks/use-trace-query', () => ({
  useTraceQuery: () => {
    if (mocks.mode === 'loading') return { isLoading: true, isError: false, refetch: mocks.refetch };
    if (mocks.mode === 'not-found') {
      return { isLoading: false, isError: true, error: new DashboardTracesRequestError(404), refetch: mocks.refetch };
    }
    if (mocks.mode === 'error') {
      return { isLoading: false, isError: true, error: new DashboardTracesRequestError(503), refetch: mocks.refetch };
    }
    if (mocks.mode === 'running') {
      return {
        data: {
          ...detail,
          trace: { ...detail.trace, endedAt: null, otelStatusCode: 'UNSET', terminationReason: undefined },
        },
        isLoading: false,
        isError: false,
        refetch: mocks.refetch,
      };
    }
    return { data: detail, isLoading: false, isError: false, refetch: mocks.refetch };
  },
}));

describe('trace detail page', () => {
  beforeEach(() => {
    mocks.mode = 'terminal';
    mocks.refetch.mockReset();
  });

  test('renders a terminal summary, usage, and every span in API order', () => {
    render(<TraceDetailPage traceId={traceId} />);

    expect(screen.getAllByText(/Failure|失败/u).length).toBeGreaterThan(0);
    expect(screen.getAllByText('provider-a').length).toBeGreaterThan(0);
    expect(screen.getByText('15')).toBeTruthy();
    expect(screen.getAllByTestId('trace-span').map((row) => row.textContent)).toEqual([
      expect.stringContaining('aio_proxy.request'),
      expect.stringContaining('aio_proxy.provider.attempt'),
      expect.stringContaining('gen_ai.inference'),
    ]);
    expect(screen.getAllByTestId('trace-span')[0]).toHaveTextContent(/SERVER/u);
    expect(screen.getAllByTestId('trace-span')[0]).toHaveTextContent(/ERROR/u);
  });

  test('renders a running root and manually refreshes it', () => {
    mocks.mode = 'running';
    render(<TraceDetailPage traceId={traceId} />);

    expect(screen.getByText(/Running|运行中/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Refresh|刷新/u }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['not-found', /Trace not found|未找到追踪/u],
    ['error', /Trace unavailable|无法加载追踪/u],
  ])('renders the %s state', (mode, expected) => {
    mocks.mode = mode;
    render(<TraceDetailPage traceId={traceId} />);
    expect(screen.getByText(expected)).toBeTruthy();
  });
});

import type { DashboardTraceDetail } from '@aio-proxy/types';
import { afterEach, beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DashboardTracesRequestError } from '../../services/traces-service';
import { TraceDetailPage } from './trace-detail-page';

const mocks = rs.hoisted(() => ({
  mode: 'terminal',
  refetch: rs.fn(),
  navigate: rs.fn(),
  data: undefined as DashboardTraceDetail | undefined,
}));
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
    usage: {
      providerId: 'provider-a',
      modelId: 'gpt-5.1',
      priceModelId: 'priced-gpt-5.1',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
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
    return { data: mocks.data ?? detail, isLoading: false, isError: false, refetch: mocks.refetch };
  },
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    preload: _preload,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    readonly to: string;
    readonly preload?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));

const summaryRow = (label: RegExp): HTMLElement => {
  const row = within(screen.getByTestId('trace-summary')).getByText(label).closest('div');
  if (row === null) throw new Error(`Missing summary row: ${label.source}`);
  return row;
};

describe('trace detail page', () => {
  beforeEach(() => {
    mocks.mode = 'terminal';
    mocks.refetch.mockReset();
    mocks.navigate.mockReset();
    mocks.data = undefined;
  });

  afterEach(() => rs.restoreAllMocks());

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
    expect(screen.getAllByTestId('trace-span')[0]).toHaveTextContent(/Failure|失败/u);
  });

  test.each(['terminal', 'loading', 'not-found', 'error'])('links the %s state back to the Trace list', (mode) => {
    mocks.mode = mode;
    render(<TraceDetailPage traceId={traceId} />);
    expect(screen.getByRole('link', { name: /Back|返回/u })).toHaveAttribute('href', '/traces');
  });

  test('shows only the Session ID and discloses its source in a tooltip', async () => {
    render(<TraceDetailPage traceId={traceId} />);

    const session = screen.getByRole('button', { name: 'cache-a' });
    expect(within(screen.getByTestId('trace-summary')).queryByText('openai-prompt-cache')).toBeNull();

    fireEvent.focus(session);
    expect(await screen.findByText(/Session source: openai-prompt-cache|会话来源：openai-prompt-cache/u)).toBeTruthy();
  });

  test('shows the requested model and discloses a different upstream model', async () => {
    render(<TraceDetailPage traceId={traceId} />);

    const row = summaryRow(/^Model$|^模型$/u);
    const requestedModel = within(row).getByText('gpt-5');
    expect(within(row).queryByText('gpt-5.1')).toBeNull();

    fireEvent.focus(requestedModel);
    expect(await screen.findByText(/Upstream model: gpt-5.1|上游模型：gpt-5.1/u)).toBeTruthy();
  });

  test('does not add an upstream-model tooltip when models match', () => {
    mocks.data = { ...detail, trace: { ...detail.trace, finalModelId: 'gpt-5' } };
    render(<TraceDetailPage traceId={traceId} />);

    fireEvent.focus(within(summaryRow(/^Model$|^模型$/u)).getByText('gpt-5'));
    expect(screen.queryByText(/Upstream model|上游模型/u)).toBeNull();
  });

  test('combines HTTP and error metadata into one result row', () => {
    render(<TraceDetailPage traceId={traceId} />);

    const row = summaryRow(/Result details|结果详情/u);
    expect(within(row).getByText('HTTP 503 · upstream_error · provider_unavailable')).toBeTruthy();
    expect(screen.queryByText(/Final HTTP status|最终 HTTP 状态码/u)).toBeNull();
    expect(screen.queryByText(/Error type|错误类型/u)).toBeNull();
    expect(screen.queryByText(/Error code|错误码/u)).toBeNull();
  });

  test('renders a completed UNSET Trace as successful', () => {
    mocks.data = {
      ...detail,
      trace: {
        ...detail.trace,
        otelStatusCode: 'UNSET',
        terminationReason: undefined,
        errorType: undefined,
        errorCode: undefined,
        finalHttpStatus: 200,
      },
      spans: detail.spans.map((span) => ({
        ...span,
        otelStatusCode: 'UNSET',
        terminationReason: undefined,
      })),
    };

    render(<TraceDetailPage traceId={traceId} />);

    expect(screen.getAllByText(/Success|成功/u).length).toBeGreaterThan(0);
    expect(screen.queryByText(/UNSET|未设置/u)).toBeNull();
  });

  test('renders the root Span ID in the complete summary', () => {
    render(<TraceDetailPage traceId={traceId} />);
    expect(within(screen.getByTestId('trace-summary')).getByText('b'.repeat(16))).toBeTruthy();
  });

  test('renders the price model ID in the usage summary', () => {
    render(<TraceDetailPage traceId={traceId} />);
    expect(screen.getByText('priced-gpt-5.1')).toBeTruthy();
  });

  test('renders a running root and manually refreshes it', () => {
    const interval = rs.spyOn(globalThis, 'setInterval');
    mocks.mode = 'running';
    render(<TraceDetailPage traceId={traceId} />);

    expect(screen.getByText(/Running|运行中/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Refresh|刷新/u }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(interval).not.toHaveBeenCalled();
  });

  test('selects the root, preserves a selected Span across refresh, and falls back when it disappears', async () => {
    const { rerender } = render(<TraceDetailPage traceId={traceId} />);
    const panel = screen.getByTestId('span-detail-panel');
    expect(within(panel).getByText('aio_proxy.request')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /aio_proxy\.provider\.attempt/u }));
    expect(within(panel).getByText('aio_proxy.provider.attempt')).toBeTruthy();

    mocks.data = { ...detail, spans: detail.spans.map((span) => ({ ...span })) };
    rerender(<TraceDetailPage traceId={traceId} />);
    expect(within(panel).getByText('aio_proxy.provider.attempt')).toBeTruthy();

    mocks.data = { ...detail, spans: [detail.spans[0]!] };
    rerender(<TraceDetailPage traceId={traceId} />);
    await waitFor(() => expect(within(panel).getByText('aio_proxy.request')).toBeTruthy());
  });

  test('navigates from Session identity to page one with exact source and ID filters', () => {
    render(<TraceDetailPage traceId={traceId} />);

    fireEvent.click(screen.getByRole('button', { name: 'cache-a' }));

    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/traces',
        search: expect.objectContaining({
          page: 1,
          sessionSource: 'openai-prompt-cache',
          sessionId: 'cache-a',
        }),
      }),
    );
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

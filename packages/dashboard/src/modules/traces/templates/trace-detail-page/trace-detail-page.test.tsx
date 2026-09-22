import { m } from '@aio-proxy/i18n';
import type { DashboardTraceDetail, DashboardTracePercentile } from '@aio-proxy/types';
import { afterEach, beforeEach, describe, expect, rs, test } from '@rstest/core';
import * as reactQuery from '@tanstack/react-query' with { rstest: 'importActual' };
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as renderRtl, screen, waitFor, within } from '@testing-library/react';

import { queryKeys } from '@/lib/query-keys';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { DashboardTracesRequestError } from '../../services/traces-service';
import { TraceDetailPage } from './trace-detail-page';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
const render: typeof renderRtl = (ui, options) =>
  renderRtl(ui, {
    ...options,
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });

const mocks = rs.hoisted(() => ({
  mode: 'terminal',
  refetch: rs.fn(),
  invalidateQueries: rs.fn(),
  navigate: rs.fn(),
  writeText: rs.fn(async () => undefined),
  data: undefined as DashboardTraceDetail | undefined,
  comparison: null as DashboardTracePercentile | null,
  percentileEnabled: [] as boolean[],
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
      // 真实的根 span 会带上失败原因（`request-trace-recorder` 的 completion 写进行里），
      // 详情面板就是从这里读出来渲染的。
      errorType: 'upstream_error',
      errorCode: 'provider_unavailable',
      attributes: { 'aio_proxy.session.id': 'cache-a' },
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
  diagnostics: {
    request: {
      protocol: 'openai-response',
      method: 'POST',
      contentType: 'application/json',
      contentLengthBytes: 35,
      userAgent: 'diagnostics-test/1.0',
    },
    response: {
      statusCode: 503,
      contentType: 'application/json',
      contentLengthBytes: 24,
    },
  },
};

rs.mock('../../hooks/use-trace-percentile-query', () => ({
  useTracePercentileQuery: (_traceId: string, enabled: boolean) => {
    mocks.percentileEnabled.push(enabled);
    return { data: { comparison: mocks.comparison } };
  },
}));

rs.mock('../../hooks/use-trace-wire-query', () => ({
  useTraceWireQuery: () => ({ data: { available: true, hops: [] }, isPending: false, isError: false }),
}));

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

// 只替掉 useQueryClient，其余照旧：traces-service 在模块加载时就要用真的 queryOptions。
rs.mock('@tanstack/react-query', () => ({
  ...reactQuery,
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
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

describe('trace detail page', () => {
  beforeEach(() => {
    mocks.mode = 'terminal';
    mocks.refetch.mockReset();
    mocks.invalidateQueries.mockReset();
    mocks.navigate.mockReset();
    mocks.writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    mocks.data = undefined;
    mocks.comparison = null;
    mocks.percentileEnabled = [];
  });

  afterEach(() => rs.restoreAllMocks());

  // 分位对比一路要穿过 template -> tabs -> 详情面板才到条上，中间任何一层漏传 prop 都是静默消失。
  test('shows the latency comparison only once the sample is large enough', () => {
    const { unmount } = render(<TraceDetailPage traceId={traceId} />);
    expect(screen.queryByTestId('trace-percentile-bar')).toBeNull();
    unmount();

    mocks.comparison = {
      modelId: 'gpt-5.1',
      sampleCount: 42,
      durationMs: 125,
      percentile: 73,
      minMs: 100,
      maxMs: 900,
      p50Ms: 300,
      p95Ms: 800,
    };
    render(<TraceDetailPage traceId={traceId} />);

    const bar = screen.getByTestId('trace-percentile-bar');
    expect(bar.textContent).toContain('42');
    expect(bar.textContent).toContain('gpt-5.1');
    expect(bar.textContent).toContain('73');
    expect(mocks.percentileEnabled.at(-1)).toBe(true);
  });

  test('renders every span in API order, marking the failing ones without relying on color', () => {
    render(<TraceDetailPage traceId={traceId} />);

    expect(screen.getAllByTestId('trace-span').map((row) => row.textContent)).toEqual([
      expect.stringContaining('aio_proxy.request'),
      expect.stringContaining('aio_proxy.provider.attempt'),
      expect.stringContaining('gen_ai.inference'),
    ]);
    expect(screen.getAllByTestId('trace-span')[0]).toHaveTextContent(/Failure|失败/u);
    expect(screen.getAllByTestId('trace-span')[2]).not.toHaveTextContent(/Failure|失败/u);
  });

  test('opens on Detail and switches to the per-hop request and response views', () => {
    render(<TraceDetailPage traceId={traceId} />);

    expect(screen.getByRole('tab', { name: /^Detail$|^详情$/u })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByTestId('trace-span')).toHaveLength(3);
    expect(within(screen.getByTestId('span-detail-panel')).getByText('aio_proxy.request')).toBeInTheDocument();

    // 抓包桩子返回空 hops：这一跳确实没有记录，就照实说（加载中和读失败由 trace-detail-tabs 的用例盯）。
    fireEvent.click(screen.getByRole('tab', { name: /^Request$|^请求$/u }));
    const hops = screen.getByRole('group', { name: /^Request hops$|^请求链路$/u });
    expect(within(hops).getByRole('button', { name: /openai-prompt-cache/u })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toBeInTheDocument();

    // 入站的响应体从来不进抓包，所以这一格仍然是常开的 allowlist 诊断。
    fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));
    expect(screen.getByRole('tab', { name: /^Response$|^响应$/u })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('heading', { name: /^Headers$|^标头$/u }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('heading', { name: /^Body$|^正文$/u }).length).toBeGreaterThan(0);
    // Scoped to the response metadata: the Detail tab's status row shows the same code.
    const httpStatus = screen.getByText(/^HTTP status$|^HTTP 状态码$/u).parentElement!;
    expect(within(httpStatus).getByText('503')).toBeInTheDocument();
    expect(screen.getByText('24')).toBeInTheDocument();
  });

  test('shows a precise unavailable state for missing response diagnostics', () => {
    mocks.data = { ...detail, diagnostics: undefined };
    render(<TraceDetailPage traceId={traceId} />);

    fireEvent.click(screen.getByRole('tab', { name: /^Response$|^响应$/u }));
    expect(screen.getByText(/Response diagnostics are unavailable|响应诊断不可用/u)).toBeInTheDocument();
  });

  test.each(['terminal', 'loading', 'not-found', 'error'])(
    'uses the Traces breadcrumb instead of a return button in the %s state',
    (mode) => {
      mocks.mode = mode;
      render(<TraceDetailPage traceId={traceId} />);

      expect(screen.queryByRole('link', { name: /Back|返回/u })).toBeNull();
      expect(screen.getByRole('link', { name: /^Traces$|^追踪$/u })).toHaveAttribute('href', '/traces');
    },
  );

  test('puts the Trace ID and status in the final breadcrumb with the copy action in the page header', async () => {
    render(<TraceDetailPage traceId={traceId} />);

    const header = screen.getByRole('banner');
    const currentBreadcrumb = within(header).getByRole('link', { name: new RegExp(traceId, 'u') });
    expect(currentBreadcrumb).toHaveAttribute('aria-current', 'page');
    expect(currentBreadcrumb).toHaveTextContent(traceId);
    expect(currentBreadcrumb).toHaveTextContent(/Failure|失败/u);
    expect(within(header).getByRole('heading', { level: 1, name: 'aio_proxy.request' })).toBeInTheDocument();

    fireEvent.click(within(header).getByRole('button', { name: /Copy Trace ID|复制追踪 ID/u }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(traceId));
  });

  test('states the failure reason of the selected Span once, without label rows', () => {
    render(<TraceDetailPage traceId={traceId} />);

    const panel = screen.getByTestId('span-detail-panel');
    expect(within(panel).getByText('upstream_error · provider_unavailable')).toBeTruthy();
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

  test('renders a running root and manually refreshes it', () => {
    const interval = rs.spyOn(globalThis, 'setInterval');
    mocks.mode = 'running';
    render(<TraceDetailPage traceId={traceId} />);

    expect(screen.getAllByText(/Running|运行中/u).length).toBeGreaterThan(0);
    expect(mocks.percentileEnabled.at(-1)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Refresh|刷新/u }));
    const invalidated = mocks.invalidateQueries.mock.calls[0]?.[0]?.queryKey as readonly unknown[];
    for (const covered of [
      queryKeys.trace(traceId),
      queryKeys.traceWire(traceId),
      queryKeys.tracePercentile(traceId),
    ]) {
      expect(covered.slice(0, invalidated.length)).toEqual(invalidated);
    }
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

  // 属性行的筛选动作要穿过 面板 -> tabs -> template 才能落到 navigate 上，中间漏一层就是点了没反应。
  test('navigates from a Span attribute to the first page of the filtered list', () => {
    render(<TraceDetailPage traceId={traceId} />);

    const table = screen.getByTestId('span-attribute-table');
    const sessionRow = within(table).getByText('aio_proxy.session.id').closest('div');
    if (sessionRow === null) throw new Error('expected the session-id attribute row');
    fireEvent.click(within(sessionRow).getByRole('button', { name: /Attribute actions|属性操作/u }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Add as filter|加为筛选条件/u }));

    const day = createDefaultTraceSearch(new Date(detail.trace.startedAt));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/traces',
        search: expect.objectContaining({
          sessionId: 'cache-a',
          startedAfter: day.startedAfter,
          startedBefore: day.startedBefore,
        }),
      }),
    );
    // 游标分页：带着上一页的 pageToken 跳过去，筛出来的第一页就被跳过了。
    expect(mocks.navigate.mock.calls[0]![0].search).not.toHaveProperty('pageToken');
  });

  test.each([
    ['not-found', /Trace not found|未找到追踪/u],
    ['error', /Trace unavailable|无法加载追踪/u],
  ])('renders the %s state', (mode, expected) => {
    mocks.mode = mode;
    render(<TraceDetailPage traceId={traceId} />);
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: m['dashboard.traces.detail_title']() })).toBeInTheDocument();
  });
});

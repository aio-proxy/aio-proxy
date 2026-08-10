import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { OverviewPage } from './overview-page';

const mocks = rs.hoisted(() => ({
  activityRefetch: rs.fn(),
  diagnosticsRefetch: rs.fn(),
  overviewRefetch: rs.fn(),
  useOverviewActivityQuery: rs.fn(),
  useOverviewDiagnosticsQuery: rs.fn(),
  useOverviewQuery: rs.fn(),
}));

rs.mock('../../hooks/use-overview-query', () => ({
  useOverviewActivityQuery: () => mocks.useOverviewActivityQuery(),
  useOverviewDiagnosticsQuery: (input: unknown) => mocks.useOverviewDiagnosticsQuery(input),
  useOverviewQuery: (input: unknown) => mocks.useOverviewQuery(input),
}));

const createOverviewData = () => ({
  range: '24h' as const,
  summary: {
    current: {
      requestCount: 42n,
      totalTokens: 8_192n,
      inputTokens: 6_000n,
      outputTokens: 2_192n,
      cacheReadTokens: 2_048n,
      cacheWriteTokens: 128n,
      cacheHitRate: 0.25,
      estimatedCostNanoUsd: 2_500_000_000n,
      averageRpm: 4.2,
      averageTpm: 819.2,
    },
    previous: {
      requestCount: 30n,
      totalTokens: 6_000n,
      inputTokens: 4_500n,
      outputTokens: 1_500n,
      cacheReadTokens: 1_024n,
      cacheWriteTokens: 64n,
      cacheHitRate: 0.2,
      estimatedCostNanoUsd: 2_000_000_000n,
      averageRpm: 3,
      averageTpm: 600,
    },
    peakRpm: 9,
    peakTpm: 1_500,
    providerCount: 2,
  },
  modelTrendByMetric: {
    requests: {
      series: [{ key: 'requests-model', kind: 'dimension' as const }],
      buckets: [{ key: '2026-01-01T00:00:00.000Z', values: { 'requests-model': 42n } }],
    },
    tokens: {
      series: [{ key: 'tokens-model', kind: 'dimension' as const }],
      buckets: [{ key: '2026-01-01T00:00:00.000Z', values: { 'tokens-model': 8_192n } }],
    },
    cost: {
      series: [{ key: 'cost-model', kind: 'dimension' as const }],
      buckets: [{ key: '2026-01-01T00:00:00.000Z', values: { 'cost-model': 2_500_000_000n } }],
    },
  },
});

const createDiagnosticsData = () => ({
  providerHealth: [
    { providerId: 'provider-a', successRate: 0.98, p95LatencyMs: 420 },
    { providerId: 'provider-b', successRate: 0.75, p95LatencyMs: 980 },
  ],
  topModelCosts: [
    { modelId: 'model-a', estimatedCostNanoUsd: 1_500_000_000n },
    { modelId: 'model-b', estimatedCostNanoUsd: 1_000_000_000n },
  ],
});

const createActivityData = () => ({
  from: '2025-08-10',
  to: '2026-08-05',
  items: [
    { date: '2026-01-03', totalTokens: 1n, models: [] },
    { date: '2026-01-01', totalTokens: 7n, models: [] },
    { date: '2026-01-02', totalTokens: 0n, models: [] },
  ],
});

let overviewData = createOverviewData();
let diagnosticsData = createDiagnosticsData();
let activityData = createActivityData();

beforeEach(() => {
  overviewData = createOverviewData();
  diagnosticsData = createDiagnosticsData();
  activityData = createActivityData();
  mocks.activityRefetch.mockReset();
  mocks.diagnosticsRefetch.mockReset();
  mocks.overviewRefetch.mockReset();
  mocks.useOverviewActivityQuery.mockReset();
  mocks.useOverviewDiagnosticsQuery.mockReset();
  mocks.useOverviewQuery.mockReset();
  mocks.useOverviewQuery.mockImplementation(() => ({
    data: overviewData,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: mocks.overviewRefetch,
  }));
  mocks.useOverviewDiagnosticsQuery.mockImplementation(() => ({
    data: diagnosticsData,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: mocks.diagnosticsRefetch,
  }));
  mocks.useOverviewActivityQuery.mockImplementation(() => ({
    data: activityData,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: mocks.activityRefetch,
  }));
});

describe('overview page', () => {
  test('renders the six KPIs in their fixed product order', () => {
    render(<OverviewPage />);

    const summary = screen.getByRole('list', { name: /Overview summary|概览摘要/u });
    const labels = within(summary)
      .getAllByTestId('kpi-label')
      .map((label) => label.textContent);

    expect(labels).toEqual(['Requests', 'Token', 'Cache hit rate', 'Cost', 'RPM', 'TPM']);
  });

  test('renders request counts beyond the Number safe range exactly', () => {
    overviewData.summary.current.requestCount = 9_007_199_254_740_993n;

    render(<OverviewPage />);

    expect(screen.getByRole('img', { name: '9,007,199,254,740,993' })).toBeInTheDocument();
  });

  test('switches trend metrics locally without refetching or adding metric query input', () => {
    render(<OverviewPage />);

    const tokens = screen.getByRole('tab', { name: /^Tokens$/u });
    fireEvent.click(tokens);
    expect(tokens).toHaveAttribute('aria-selected', 'true');
    const cost = screen.getByRole('tab', { name: /^Cost$/u });
    fireEvent.click(cost);
    expect(cost).toHaveAttribute('aria-selected', 'true');

    expect(mocks.overviewRefetch).not.toHaveBeenCalled();
    expect(mocks.diagnosticsRefetch).not.toHaveBeenCalled();
    expect(mocks.activityRefetch).not.toHaveBeenCalled();
    const receivedRange24h = (calls: readonly [unknown][]) =>
      calls.every(([input]) => JSON.stringify(input) === '{"range":"24h"}');
    expect(receivedRange24h(mocks.useOverviewQuery.mock.calls)).toBe(true);
    expect(receivedRange24h(mocks.useOverviewDiagnosticsQuery.mock.calls)).toBe(true);
  });

  test('decodes model transport keys before presenting the chart legend', () => {
    const chartBounds = rs.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    overviewData.modelTrendByMetric.requests.series = [
      { key: 'dimension:gpt-4%2E1', kind: 'dimension' as const },
      { key: '__other__', kind: 'other' as const },
    ];
    overviewData.modelTrendByMetric.requests.buckets = [
      { key: '2026-01-01T00:00:00.000Z', values: { 'dimension:gpt-4%2E1': 40n, __other__: 2n } },
    ];

    render(<OverviewPage />);

    expect(screen.getByText('gpt-4.1')).toBeInTheDocument();
    expect(screen.queryByText('dimension:gpt-4%2E1')).not.toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    chartBounds.mockRestore();
  });

  test('changes only range query input and keeps refresh immediately before the range tabs', () => {
    render(<OverviewPage />);

    const refresh = screen.getByRole('button', { name: /Refresh overview|刷新概览/u });
    const rangeTabs = screen.getByRole('tablist', { name: /Overview range|概览时间范围/u });
    expect(refresh.compareDocumentPosition(rangeTabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(refresh);
    expect(mocks.overviewRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.diagnosticsRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.activityRefetch).toHaveBeenCalledTimes(1);

    expect(mocks.useOverviewActivityQuery).toHaveBeenLastCalledWith();
    expect(mocks.useOverviewQuery).toHaveBeenLastCalledWith({ range: '24h' });

    fireEvent.click(screen.getByRole('tab', { name: /7d|7 天|7 日|7일/u }));
    expect(mocks.useOverviewQuery).toHaveBeenLastCalledWith({ range: '7d' });
    expect(mocks.useOverviewActivityQuery).toHaveBeenLastCalledWith();
  });

  test('keeps unwindowed diagnostics visible when the selected range has no requests', () => {
    overviewData.summary.current.requestCount = 0n;

    render(<OverviewPage />);

    expect(screen.getByText(/No requests in 24h|24 小时内暂无请求/u)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Provider health|提供商健康状态/u })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Top model costs|模型成本排行/u })).toBeInTheDocument();
  });

  test('formats a retained trend with the range that produced the loaded buckets', () => {
    const chartBounds = rs.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    mocks.useOverviewQuery.mockImplementation((input: { range: string }) => ({
      data: overviewData,
      isError: false,
      isFetching: input.range !== overviewData.range,
      isLoading: false,
      refetch: mocks.overviewRefetch,
    }));
    render(<OverviewPage />);

    fireEvent.click(screen.getByRole('tab', { name: /7d|7 天|7 日|7일/u }));

    expect(screen.getByText(/\d{2}:\d{2}\s?(?:AM|PM)/u)).toBeInTheDocument();
    chartBounds.mockRestore();
  });

  test('shows loading while the selected range has placeholder data', () => {
    mocks.useOverviewQuery.mockImplementation((input: { range: string }) => ({
      data: overviewData,
      isError: false,
      isFetching: input.range === '7d',
      isLoading: false,
      isPlaceholderData: input.range === '7d',
      refetch: mocks.overviewRefetch,
    }));
    mocks.useOverviewDiagnosticsQuery.mockImplementation((input: { range: string }) => ({
      data: diagnosticsData,
      isError: false,
      isFetching: input.range === '7d',
      isLoading: false,
      isPlaceholderData: input.range === '7d',
      refetch: mocks.diagnosticsRefetch,
    }));

    render(<OverviewPage />);
    fireEvent.click(screen.getByRole('tab', { name: /7d|7 天|7 日|7일/u }));

    expect(screen.getByRole('status')).toHaveTextContent(/Loading overview|正在加载概览/u);
  });

  test('distinguishes no configured Provider from an empty selected range', () => {
    overviewData.summary.providerCount = 0;
    const first = render(<OverviewPage />);
    expect(screen.getByText(/No Providers configured|未配置提供商/u)).toBeInTheDocument();

    first.unmount();
    overviewData = createOverviewData();
    overviewData.summary.current.requestCount = 0n;
    render(<OverviewPage />);
    expect(screen.getByText(/No requests in 24h|24 小时内暂无请求/u)).toBeInTheDocument();
  });
});

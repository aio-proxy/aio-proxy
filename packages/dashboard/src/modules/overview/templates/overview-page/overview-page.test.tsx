import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { OverviewPage } from './overview-page';

const mocks = rs.hoisted(() => ({
  refetch: rs.fn(),
  useOverviewQuery: rs.fn(),
}));

rs.mock('../../hooks/use-overview-query', () => ({
  useOverviewQuery: (input: unknown) => mocks.useOverviewQuery(input),
}));

const createOverviewData = () => ({
  range: '24h' as const,
  summary: {
    requestCount: 42n,
    totalTokens: 8_192n,
    cacheReadTokens: 2_048n,
    cacheWriteTokens: 128n,
    cacheHitRate: 0.25,
    estimatedCostNanoUsd: 2_500_000_000n,
    averageRpm: 4.2,
    averageTpm: 819.2,
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
  providerHealth: [
    { providerId: 'provider-a', successRate: 0.98, p95LatencyMs: 420 },
    { providerId: 'provider-b', successRate: 0.75, p95LatencyMs: 980 },
  ],
  topModelCosts: [
    { modelId: 'model-a', estimatedCostNanoUsd: 1_500_000_000n },
    { modelId: 'model-b', estimatedCostNanoUsd: 1_000_000_000n },
  ],
  activity: {
    year: 2026,
    days: [
      { date: '2026-01-01', requestCount: 7n },
      { date: '2026-01-02', requestCount: 0n },
    ],
  },
});

let overviewData = createOverviewData();

beforeEach(() => {
  overviewData = createOverviewData();
  mocks.refetch.mockReset();
  mocks.useOverviewQuery.mockReset();
  mocks.useOverviewQuery.mockImplementation(() => ({
    data: overviewData,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: mocks.refetch,
  }));
});

describe('overview page', () => {
  test('renders the six KPIs in their fixed product order', () => {
    render(<OverviewPage />);

    const summary = screen.getByRole('list', { name: /Overview summary|概览摘要/u });
    const labels = within(summary)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);

    expect(labels).toEqual(['Requests', 'Token', 'Cache hit rate', 'Cost', 'RPM', 'TPM']);
  });

  test('switches trend metrics locally without refetching or adding metric query input', () => {
    render(<OverviewPage />);

    const tokens = screen.getByRole('tab', { name: /^Tokens$/u });
    fireEvent.click(tokens);
    expect(tokens).toHaveAttribute('aria-selected', 'true');
    const cost = screen.getByRole('tab', { name: /^Cost$/u });
    fireEvent.click(cost);
    expect(cost).toHaveAttribute('aria-selected', 'true');

    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(
      mocks.useOverviewQuery.mock.calls.every(([input]) => JSON.stringify(input) === '{"range":"24h","year":2026}'),
    ).toBe(true);
  });

  test('changes only range and year query input and keeps refresh immediately before the range tabs', () => {
    render(<OverviewPage />);

    const refresh = screen.getByRole('button', { name: /Refresh overview|刷新概览/u });
    const rangeTabs = screen.getByRole('tablist', { name: /Overview range|概览时间范围/u });
    expect(refresh.compareDocumentPosition(rangeTabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /7d|7 天|7 日|7일/u }));
    expect(mocks.useOverviewQuery).toHaveBeenLastCalledWith({ range: '7d', year: 2026 });

    fireEvent.click(screen.getByRole('button', { name: /Previous year|上一年|前年|이전 연도/u }));
    expect(mocks.useOverviewQuery).toHaveBeenLastCalledWith({ range: '7d', year: 2025 });
  });

  test('shows only the selected activity date and count after clicking a day', () => {
    render(<OverviewPage />);

    fireEvent.click(screen.getByRole('button', { name: /7 requests|7 个请求|7 件のリクエスト|요청 7건/u }));

    const selectedDay = screen.getByRole('status');
    expect(selectedDay.childElementCount).toBe(2);
    expect(within(selectedDay).getByText(/January 1, 2026|2026/u)).toBeInTheDocument();
    expect(within(selectedDay).getByText(/7 requests|7 个请求|7 件のリクエスト|요청 7건/u)).toBeInTheDocument();
  });

  test('distinguishes no configured Provider from an empty selected range', () => {
    overviewData.summary.providerCount = 0;
    const first = render(<OverviewPage />);
    expect(screen.getByText(/No Providers configured|未配置提供商/u)).toBeInTheDocument();

    first.unmount();
    overviewData = createOverviewData();
    overviewData.summary.requestCount = 0n;
    render(<OverviewPage />);
    expect(screen.getByText(/No requests in this range|此时间范围内暂无请求/u)).toBeInTheDocument();
  });
});

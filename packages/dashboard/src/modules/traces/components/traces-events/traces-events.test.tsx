import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';

import { createDefaultTraceSearch, type TraceSearch } from '../../lib/trace-search';
import { TracesEvents } from './traces-events';

const mocks = rs.hoisted(() => ({ summarySearch: rs.fn() }));

rs.mock('../../hooks/use-trace-summary-query', () => ({
  useTraceSummaryQuery: (search: unknown, autoRefresh: boolean) => {
    mocks.summarySearch(search, autoRefresh);
    return {
      data: {
        bucket: '1m',
        buckets: [
          { at: '2026-07-27T08:00:00.000Z', success: 18_307, error: 0 },
          { at: '2026-07-27T08:01:00.000Z', success: 0, error: 93 },
        ],
        totals: { success: 18_307, error: 93 },
      },
      isLoading: false,
      isError: false,
    };
  },
}));

rs.mock('../traces-events-chart', () => ({
  TracesEventsChart: ({ onBucketSelect }: { readonly onBucketSelect: (at: string) => void }) => (
    <button type="button" onClick={() => onBucketSelect('2026-07-27T08:01:00.000Z')}>
      pick bucket
    </button>
  ),
}));

const renderEvents = (search: TraceSearch = createDefaultTraceSearch()) => {
  const onChange = rs.fn();
  // 每次渲染一个独立的 jotai store：atomWithStorage 在 store 初始化时读一次 localStorage，
  // 用默认 store 的话上一个用例的折叠状态会漏进下一个。
  const { unmount } = render(
    <Provider store={createStore()}>
      <TracesEvents search={search} autoRefresh={false} onChange={onChange} />
    </Provider>,
  );
  return { onChange, unmount };
};

const successChip = () => screen.getByRole('button', { name: /Success|成功/u });
const errorChip = () => screen.getByRole('button', { name: /Failure|失败|失敗/u });

describe('TracesEvents', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.summarySearch.mockClear();
  });

  test('shows the range totals on the legend chips', () => {
    renderEvents();

    expect(successChip()).toHaveTextContent('18,307');
    expect(errorChip()).toHaveTextContent('93');
  });

  test('uses the legend chips as the otel status filter', () => {
    const { onChange } = renderEvents();

    expect(errorChip()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(errorChip());

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ otelStatusCode: 'ERROR' }));
  });

  test('clears the status filter when the pressed chip is clicked again', () => {
    const search = { ...createDefaultTraceSearch(), otelStatusCode: 'ERROR' as const };
    const { onChange } = renderEvents(search);

    expect(errorChip()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(errorChip());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty('otelStatusCode');
  });

  test('narrows the time range to the clicked bucket', () => {
    const { onChange } = renderEvents();

    fireEvent.click(screen.getByRole('button', { name: 'pick bucket' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAfter: '2026-07-27T08:01:00.000Z',
        // 桶宽从相邻两个桶的间隔推出来，闭区间的右端减 1ms
        startedBefore: '2026-07-27T08:01:59.999Z',
      }),
    );
  });

  test('never selects past the end of the range on a truncated last bucket', () => {
    // 范围不是桶宽的整数倍：最后一个桶被服务端截短了，整桶宽会伸到图外面去。
    const search = { ...createDefaultTraceSearch(), startedBefore: '2026-07-27T08:01:30.000Z' };
    const { onChange } = renderEvents(search);

    fireEvent.click(screen.getByRole('button', { name: 'pick bucket' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAfter: '2026-07-27T08:01:00.000Z',
        startedBefore: '2026-07-27T08:01:30.000Z',
      }),
    );
  });

  test('keeps the collapsed preference in localStorage', () => {
    const { unmount } = renderEvents();

    fireEvent.click(screen.getByRole('button', { name: /Collapse chart|折叠图表/u }));

    expect(screen.queryByRole('button', { name: 'pick bucket' })).toBeNull();
    expect(window.localStorage.getItem('aio-proxy:traces-events-collapsed')).toBe('true');

    // 卸载再挂一次，模拟下次打开页面：留着上一次的 DOM，两张卡片的同名按钮会互相打架。
    unmount();
    renderEvents();

    expect(screen.queryByRole('button', { name: 'pick bucket' })).toBeNull();
    expect(screen.getByRole('button', { name: /Expand chart|展开图表/u })).toHaveAttribute('aria-expanded', 'false');
  });

  test('passes the search and the auto refresh flag straight to the summary query', () => {
    const search = { ...createDefaultTraceSearch(), pageToken: 'token' };
    renderEvents(search);

    expect(mocks.summarySearch).toHaveBeenCalledWith(search, false);
  });
});

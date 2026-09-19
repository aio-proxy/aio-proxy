import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';

import { createDefaultTraceSearch, type TraceSearch } from '../../lib/trace-search';
import { TracesEvents } from './traces-events';

const twoBuckets = [
  { at: '2026-07-27T08:00:00.000Z', success: 18_307, error: 0 },
  { at: '2026-07-27T08:01:00.000Z', success: 0, error: 93 },
];

const mocks = rs.hoisted(() => ({
  summarySearch: rs.fn(),
  summary: undefined as unknown,
}));

rs.mock('../../hooks/use-trace-summary-query', () => ({
  useTraceSummaryQuery: (search: unknown, autoRefresh: boolean) => {
    mocks.summarySearch(search, autoRefresh);
    return mocks.summary;
  },
}));

rs.mock('../traces-events-chart', () => ({
  TracesEventsChart: ({
    canZoom,
    onBucketSelect,
  }: {
    readonly canZoom: boolean;
    readonly onBucketSelect: (at: string) => void;
  }) => (
    <button type="button" data-can-zoom={canZoom} onClick={() => onBucketSelect('2026-07-27T08:01:00.000Z')}>
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
    mocks.summary = {
      data: { bucket: '1m', buckets: twoBuckets, totals: { success: 18_307, error: 93 } },
      isLoading: false,
      isError: false,
    };
  });

  test('shows the range totals on the legend chips', () => {
    renderEvents();

    expect(successChip()).toHaveTextContent('18,307');
    expect(errorChip()).toHaveTextContent('93');
  });

  test('uses the legend chips as the outcome filter', () => {
    const { onChange } = renderEvents();

    expect(errorChip()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(errorChip());

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  test('clears the outcome filter when the pressed chip is clicked again', () => {
    const search = { ...createDefaultTraceSearch(), outcome: 'error' as const };
    const { onChange } = renderEvents(search);

    expect(errorChip()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(errorChip());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty('outcome');
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

  test('stops advertising zoom once the range is down to a single bucket', () => {
    // 1m 粒度下每次成功缩放都停在这个状态，再点一次是空操作，不能还摆着可点的样子。
    mocks.summary = {
      data: { bucket: '1m', buckets: twoBuckets.slice(0, 1), totals: { success: 18_307, error: 0 } },
      isLoading: false,
      isError: false,
    };
    renderEvents();

    expect(screen.queryByText(/Click a bar|点击柱体/u)).toBeNull();
    expect(screen.getByRole('button', { name: 'pick bucket' })).toHaveAttribute('data-can-zoom', 'false');
  });

  test('keeps the last good chart and flags it as stale instead of replacing it with an error', () => {
    // 轮询失败时 TanStack Query 还留着上一次的 data。图继续画旧数据，所以必须有个
    // 说明，否则用户看到的是一张假装是当前的图。
    mocks.summary = {
      data: { bucket: '1m', buckets: twoBuckets, totals: { success: 18_307, error: 93 } },
      isLoading: false,
      isError: true,
    };
    renderEvents();

    expect(screen.getByRole('button', { name: 'pick bucket' })).toBeInTheDocument();
    // 图在画数字，文案就得说「这是旧的」而不是「加载不出来」。
    const notice = screen.getByText(/Showing last loaded data|显示的是上次加载的数据/u);
    expect(notice).toBeInTheDocument();
    // 提示落在表头，不是盖在图上的那一整块。
    expect(notice.closest('header')).not.toBeNull();
  });

  test('calls a first-load failure a failure, not stale data', () => {
    // 一次都没成功过就没有「上次加载的数据」可言。两句话同时出现的话，表头和正文
    // 会对同一次请求给出互相矛盾的说法。
    mocks.summary = { data: undefined, isLoading: false, isError: true };
    renderEvents();

    expect(
      screen.getByText(/Traces unavailable|无法加载追踪|無法載入追蹤|トレースを利用できません|사용할 수 없음/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Showing last loaded data|显示的是上次加载的数据|顯示的是上次載入的資料/u)).toBeNull();
  });
});

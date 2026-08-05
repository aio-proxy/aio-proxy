import { describe, expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { TracesFilterRail } from './traces-filter-rail';

const filters = { autoRefresh: true, refreshing: false, onAutoRefresh: rs.fn(), onRefresh: rs.fn() };
const renderRail = (search = createDefaultTraceSearch()) =>
  render(<TracesFilterRail search={search} onSearchChange={rs.fn()} {...filters} />);

describe('TracesFilterRail', () => {
  test('organizes filters into semantic accordion groups without a more-filters control', () => {
    renderRail();

    expect(screen.getByTestId('traces-filter-rail')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /Filters|筛选/u })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Time range|时间范围/u })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Request$|^请求$/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Result details|结果详情/u })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /More filters|更多筛选/u })).toBeNull();
    expect(screen.getByRole('button', { name: /Refresh|刷新/u })).toBeTruthy();
  });

  test('shows auto-refresh only for the token-free latest page', () => {
    const latestSearch = createDefaultTraceSearch();
    const view = renderRail(latestSearch);

    expect(screen.getByRole('switch', { name: /Auto refresh|自动刷新/u })).toBeTruthy();

    view.rerender(
      <TracesFilterRail search={{ ...latestSearch, pageToken: 'older-token' }} onSearchChange={rs.fn()} {...filters} />,
    );
    expect(screen.queryByRole('switch', { name: /Auto refresh|自动刷新/u })).toBeNull();
  });
});

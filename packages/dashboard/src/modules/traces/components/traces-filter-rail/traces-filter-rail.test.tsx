import { afterEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../trace-search';
import { TracesFilterRail } from './traces-filter-rail';

const viewport = rs.hoisted(() => ({ mobile: false }));

rs.mock('@aio-proxy/ui/hooks/use-mobile', () => ({
  useIsMobile: () => viewport.mobile,
}));

afterEach(() => {
  viewport.mobile = false;
});

const renderRail = () => {
  const filters = { autoRefresh: true, refreshing: false, onAutoRefresh: rs.fn(), onRefresh: rs.fn() };
  return render(<TracesFilterRail search={createDefaultTraceSearch()} onSearchChange={rs.fn()} {...filters} />);
};

describe('TracesFilterRail', () => {
  test('moves the rail into the search bar and returns focus when collapsed', () => {
    renderRail();

    const collapse = screen.getByRole('button', { name: /Collapse filters|收起筛选/u });
    collapse.focus();
    fireEvent.click(collapse);

    expect(screen.queryByTestId('traces-filter-rail')).toBeNull();
    const advancedFilter = screen.getByRole('button', { name: /Advanced filters|高级筛选/u });
    expect(advancedFilter).toHaveFocus();
    expect(screen.getAllByRole('button', { name: /Advanced filters|高级筛选/u })).toHaveLength(1);

    fireEvent.click(advancedFilter);
    expect(screen.getByTestId('traces-filter-rail')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Advanced filters|高级筛选/u })).toBeNull();
  });

  test('uses one header disclosure on narrow layouts', () => {
    viewport.mobile = true;
    renderRail();

    const disclosure = screen.getByRole('button', { name: /Filters|筛选/u });
    expect(screen.queryByRole('button', { name: /Advanced filters|高级筛选/u })).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByTestId('traces-filter-rail')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Filters|筛选/u })).toHaveLength(1);
  });
});

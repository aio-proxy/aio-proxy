import { describe, expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { TracesFilterRail } from './traces-filter-rail';

const renderRail = () => {
  const filters = { autoRefresh: true, refreshing: false, onAutoRefresh: rs.fn(), onRefresh: rs.fn() };
  return render(<TracesFilterRail search={createDefaultTraceSearch()} onSearchChange={rs.fn()} {...filters} />);
};

describe('TracesFilterRail', () => {
  test('groups filters and actions in the local sidebar', () => {
    renderRail();

    expect(screen.getByTestId('traces-filter-rail')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: /Filters|筛选/u })).toBeTruthy();
    expect(screen.getByLabelText(/Time range|时间范围/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /More filters|更多筛选/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Refresh|刷新/u })).toBeTruthy();
  });
});

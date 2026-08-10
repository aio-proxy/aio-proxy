import { SidebarProvider } from '@aio-proxy/ui/components/sidebar';
import { describe, expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { TracesFilters } from './traces-filters';

const filters = { autoRefresh: true, refreshing: false, onAutoRefresh: rs.fn(), onRefresh: rs.fn() };
const renderFilters = (search = createDefaultTraceSearch()) =>
  render(
    <SidebarProvider>
      <TracesFilters search={search} onChange={rs.fn()} {...filters} />
    </SidebarProvider>,
  );

describe('TracesFilters', () => {
  test('renders the complete filter sidebar', () => {
    renderFilters();

    const heading = screen.getByRole('heading', { level: 2, name: /Filters|筛选/u });
    expect(heading.closest('[data-slot="sidebar"]')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Time range|时间范围/u })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Request$|^请求$/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Result details|结果详情/u })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /More filters|更多筛选/u })).toBeNull();
    expect(screen.getByRole('button', { name: /Refresh|刷新/u })).toBeTruthy();
  });

  test('shows auto-refresh only for the token-free latest page', () => {
    const latestSearch = createDefaultTraceSearch();
    const view = renderFilters(latestSearch);

    expect(screen.getByRole('switch', { name: /Auto refresh|自动刷新/u })).toBeTruthy();

    view.rerender(
      <SidebarProvider>
        <TracesFilters search={{ ...latestSearch, pageToken: 'older-token' }} onChange={rs.fn()} {...filters} />
      </SidebarProvider>,
    );
    expect(screen.queryByRole('switch', { name: /Auto refresh|自动刷新/u })).toBeNull();
  });
});

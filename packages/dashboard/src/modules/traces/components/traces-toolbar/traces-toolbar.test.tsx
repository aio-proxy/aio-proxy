import { SidebarProvider } from '@aio-proxy/ui/components/sidebar';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { TracesToolbar } from './traces-toolbar';

const renderToolbar = (overrides: Partial<React.ComponentProps<typeof TracesToolbar>> = {}) => {
  const props = {
    search: createDefaultTraceSearch(),
    autoRefresh: false,
    onChange: rs.fn(),
    onAutoRefresh: rs.fn(),
    ...overrides,
  };
  render(
    <SidebarProvider defaultOpen={false}>
      <TracesToolbar {...props} />
    </SidebarProvider>,
  );
  return props;
};

describe('TracesToolbar', () => {
  test('points the filters trigger at the filter drawer', () => {
    renderToolbar();

    const trigger = screen.getByRole('button', { name: /Filters|筛选/u });
    expect(trigger).toHaveAttribute('data-sidebar', 'trigger');
    expect(trigger).toHaveAttribute('aria-controls', 'traces-filters');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('exposes the time range next to the filters trigger', () => {
    renderToolbar();

    expect(screen.getByRole('button', { name: /Time range|时间范围/u })).toBeTruthy();
  });

  test('toggles live updates and reports the pressed state', () => {
    const { onAutoRefresh } = renderToolbar({ autoRefresh: false });

    const live = screen.getByRole('button', { name: /Live|实时/u });
    expect(live).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(live);

    expect(onAutoRefresh).toHaveBeenCalledWith(true);
  });

  test('hides live updates on a paginated page', () => {
    renderToolbar({ search: { ...createDefaultTraceSearch(), pageToken: 'older-token' } });

    expect(screen.queryByRole('button', { name: /Live|实时/u })).toBeNull();
  });
});

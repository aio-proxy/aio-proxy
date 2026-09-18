import { SidebarProvider } from '@aio-proxy/ui/components/sidebar';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { TracesFilters } from '../traces-filters';
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
  test('points the filters trigger at a drawer element that really exists', () => {
    const search = createDefaultTraceSearch();
    render(
      <SidebarProvider defaultOpen={false}>
        <TracesToolbar search={search} autoRefresh={false} onChange={rs.fn()} onAutoRefresh={rs.fn()} />
        <TracesFilters
          search={search}
          autoRefresh={false}
          refreshing={false}
          onChange={rs.fn()}
          onAutoRefresh={rs.fn()}
          onRefresh={rs.fn()}
        />
      </SidebarProvider>,
    );

    const trigger = screen.getByRole('button', { name: /Filters|筛选/u });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // 只比对按钮上的 id 字面量是假护栏：抽屉那头把 id 挂在一个移动端根本不渲染的节点上时，
    // 它照样是绿的。要验的是这条关系落到了一个真实存在的元素上。
    const controls = trigger.getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    expect(document.getElementById(controls ?? '')).not.toBeNull();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('counts the active filters on the trigger so a collapsed drawer still shows them', () => {
    renderToolbar({
      search: { ...createDefaultTraceSearch(), otelStatusCode: 'ERROR', requestedModelId: 'claude-sonnet-4-6' },
    });

    // 角标是唯一能看出抽屉里还开着筛选的地方，数字必须是筛选条件数，不是别的什么。
    expect(screen.getByRole('button', { name: /Filters|筛选/u })).toHaveTextContent('2');
  });

  test('leaves the filters trigger unadorned when only the toolbar controls are set', () => {
    renderToolbar({ search: { ...createDefaultTraceSearch(), outcome: 'error' } });

    // 默认落地就带着时间范围和分页大小，成败由图例 chip 管，它们各有自己的控件，
    // 算进角标会让按钮永远显示数字。
    expect(screen.getByRole('button', { name: /Filters|筛选/u })).not.toHaveTextContent(/\d/u);
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

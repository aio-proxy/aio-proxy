import { afterEach, describe, expect, rs, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';

import { DateTimeRangePicker } from './date-time-range-picker';
import { openPicker, value } from './date-time-range-picker.test-support';

const viewport = rs.hoisted(() => ({ mobile: false }));

rs.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => viewport.mobile,
}));

afterEach(() => {
  viewport.mobile = false;
});

describe('DateTimeRangePicker responsive layout', () => {
  test('uses a bottom Sheet on mobile', async () => {
    viewport.mobile = true;
    render(
      <DateTimeRangePicker
        value={value}
        presets={[
          { id: 'today', label: 'Today', resolve: () => value },
          { id: 'yesterday', label: 'Yesterday', resolve: () => value },
        ]}
        onChange={rs.fn()}
      />,
    );

    openPicker();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-slot', 'sheet-content');
    expect(dialog).toHaveAttribute('data-side', 'bottom');
    expect(within(dialog).getAllByTestId('date-time-range-calendar')).toHaveLength(1);
    expect(within(dialog).getAllByRole('button', { name: 'Today' })).toHaveLength(1);
    expect(within(dialog).getByLabelText(/Start|开始时间/u)).toBeTruthy();
    expect(within(dialog).getByLabelText(/End|结束时间/u)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Apply|应用/u })).toBeTruthy();

    const panel = within(dialog).getByTestId('date-time-range-panel');
    const calendar = within(dialog).getByTestId('date-time-range-calendar');
    const presets = dialog.querySelector('[data-slot="date-time-range-presets"]');
    const fields = dialog.querySelector('[data-slot="date-time-range-fields"]');
    const actions = dialog.querySelector('[data-slot="date-time-range-actions"]');
    if (presets === null || fields === null || actions === null) throw new Error('Expected responsive picker regions');

    expect(dialog).toHaveClass('rounded-t-3xl');
    expect(panel).toHaveClass('w-full');
    expect(calendar).toHaveClass('w-full', 'p-0');
    expect(calendar).not.toHaveClass('w-fit');
    expect(presets).toHaveClass('grid-cols-2');
    expect(fields).toHaveClass('grid');
    expect(fields).not.toHaveClass('grid-cols-2');
    expect(actions).not.toHaveClass('sticky');
    expect(within(actions as HTMLElement).getByRole('button', { name: /Apply|应用/u })).toHaveClass('w-full');
  });

  test('uses a Popover on desktop', async () => {
    render(
      <DateTimeRangePicker
        value={value}
        presets={[{ id: 'today', label: 'Today', resolve: () => value }]}
        onChange={rs.fn()}
      />,
    );

    openPicker();
    const panel = await screen.findByTestId('date-time-range-panel');
    const primary = panel.querySelector('[data-slot="date-time-range-primary"]');
    const presets = panel.querySelector('[data-slot="date-time-range-presets"]');
    const fields = panel.querySelector('[data-slot="date-time-range-fields"]');
    const actions = panel.querySelector('[data-slot="date-time-range-actions"]');
    if (primary === null || presets === null || fields === null || actions === null) {
      throw new Error('Expected desktop picker regions');
    }

    const calendar = within(panel).getByTestId('date-time-range-calendar');
    expect(panel).toHaveClass('w-auto', 'max-w-[calc(100vw-2rem)]', 'grid-cols-[auto_11rem]');
    expect(primary).toHaveClass('w-64', 'border-r', 'pr-4');
    expect(calendar).toHaveClass('w-full', 'p-0');
    expect(presets).toHaveClass('grid', 'content-start');
    expect(presets).not.toHaveClass('flex-wrap');
    expect(within(presets as HTMLElement).getByRole('button', { name: 'Today' })).toHaveClass(
      'hover:bg-muted',
      'justify-start',
    );
    expect(fields).toHaveClass('grid');
    expect(fields).not.toHaveClass('grid-cols-2');
    expect(actions).toHaveClass('justify-end');
    expect(primary.contains(fields)).toBe(true);
    expect(primary.contains(actions)).toBe(true);
    expect(primary.contains(presets)).toBe(false);
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });
});

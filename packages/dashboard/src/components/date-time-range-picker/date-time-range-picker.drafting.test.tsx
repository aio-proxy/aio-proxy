import { afterEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DateTimeRangePicker } from './date-time-range-picker';
import { openPicker, value } from './date-time-range-picker.test-support';

const viewport = rs.hoisted(() => ({ mobile: false }));

rs.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => viewport.mobile,
}));

afterEach(() => {
  viewport.mobile = false;
});

describe('DateTimeRangePicker drafting', () => {
  test('keeps calendar and time edits in draft until Apply', async () => {
    const onChange = rs.fn();
    render(<DateTimeRangePicker value={value} onChange={onChange} />);

    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: '2026-07-20 08:15' },
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Apply|应用/u }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]?.[0].from).toEqual(new Date(2026, 6, 20, 8, 15, 0, 0));
  });

  test('derives Calendar selection from manual draft edits', async () => {
    render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: '2026-07-21 00:00' },
    });
    fireEvent.change(screen.getByLabelText(/End|结束时间/u), {
      target: { value: '2026-07-21 23:59' },
    });

    expect(
      within(screen.getByTestId('date-time-range-calendar')).getByRole('button', {
        name: /Tuesday, July 21st, 2026/u,
      }),
    ).toHaveAttribute('data-range-start', 'true');
  });

  test('applies a preset immediately', async () => {
    const onChange = rs.fn();
    const now = new Date(2026, 6, 20, 12, 0);
    const resolve = rs.fn(() => ({ from: new Date(2026, 6, 20, 11, 0), to: now }));
    render(
      <DateTimeRangePicker
        value={{ from: now, to: now }}
        presets={[{ id: '1h', label: 'Past hour', resolve }]}
        onChange={onChange}
      />,
    );

    openPicker();
    fireEvent.click(await screen.findByRole('button', { name: 'Past hour' }));
    expect(resolve).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]?.[0].from).toEqual(new Date(2026, 6, 20, 11, 0));
    expect(screen.queryByRole('button', { name: /Apply|应用/u })).not.toBeInTheDocument();
  });

  test('discards the draft when the Popover closes without Apply', async () => {
    const onChange = rs.fn();
    render(<DateTimeRangePicker value={value} onChange={onChange} />);
    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: '2026-07-20 08:15' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText(/Start|开始时间/u)).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  test('renders one calendar month and writes full-day boundaries after a completed selection', async () => {
    render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
    openPicker();
    const calendar = await screen.findByTestId('date-time-range-calendar');
    expect(within(calendar).getAllByRole('grid')).toHaveLength(1);

    fireEvent.click(within(calendar).getByRole('button', { name: /Tuesday, July 21st, 2026/u }));
    expect(screen.getByLabelText(/Start|开始时间/u)).toHaveValue('2026-07-20 00:00');
    expect(screen.getByLabelText(/End|结束时间/u)).toHaveValue('2026-07-21 23:59');
  });

  test('uses a custom trigger', () => {
    render(
      <DateTimeRangePicker value={value} trigger={<button type="button">Custom range</button>} onChange={rs.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }));
    expect(screen.getByRole('button', { name: /Apply|应用/u })).toBeTruthy();
  });

  test('preserves a valid external endpoint when its sibling Date is invalid', async () => {
    render(<DateTimeRangePicker value={{ from: new Date(Number.NaN), to: value.to }} onChange={rs.fn()} />);
    openPicker();
    expect(await screen.findByLabelText(/Start|开始时间/u)).toHaveValue('');
    expect(screen.getByLabelText(/End|结束时间/u)).toHaveValue('2026-07-20 23:59');
    expect(screen.getByRole('button', { name: /Apply|应用/u })).toBeDisabled();
  });
});

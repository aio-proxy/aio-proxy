import { afterEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { DateTimeRangePicker } from './date-time-range-picker';
import { openPicker, value } from './date-time-range-picker.test-support';

const viewport = rs.hoisted(() => ({ mobile: false }));

rs.mock('@aio-proxy/ui/hooks/use-mobile', () => ({
  useIsMobile: () => viewport.mobile,
}));

afterEach(() => {
  viewport.mobile = false;
});

describe('DateTimeRangePicker validation', () => {
  test('disables Apply for invalid text', async () => {
    render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), { target: { value: 'bad' } });
    expect(screen.getByRole('button', { name: /Apply|应用/u })).toBeDisabled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  test('renders an order error for a reversed range', async () => {
    render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: '2026-07-21T00:00' },
    });
    fireEvent.change(screen.getByLabelText(/End|结束时间/u), {
      target: { value: '2026-07-20T23:59' },
    });

    expect(screen.getByRole('button', { name: /Apply|应用/u })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Start must not be after end|开始时间不能晚于结束时间/u);
  });

  test('renders an invalid or after-max End error beside End', async () => {
    render(<DateTimeRangePicker value={value} max={new Date(2026, 6, 20, 23, 59, 59, 999)} onChange={rs.fn()} />);
    openPicker();
    const start = await screen.findByLabelText(/Start|开始时间/u);
    const end = screen.getByLabelText(/End|结束时间/u);
    fireEvent.change(end, { target: { value: '2026-07-21T00:00' } });

    const startField = start.closest('[data-slot="field"]');
    const endField = end.closest('[data-slot="field"]');
    expect(startField).not.toBeNull();
    expect(endField).not.toBeNull();
    expect(within(startField as HTMLElement).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(endField as HTMLElement).getByRole('alert')).toHaveTextContent(
      /End is after the allowed range|结束时间晚于允许范围/u,
    );
    expect(screen.getByRole('button', { name: /Apply|应用/u })).toBeDisabled();
  });
});

import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { WeightSliderField } from './weight-slider-field';

// Base UI nests one `<input type="range">` per thumb, so the slider role count IS the thumb count.
// `hidden: true` is required, not cosmetic: the thumb carries `visibility: hidden` until it measures
// the track, and happy-dom has no layout, so every thumb sits outside the accessibility tree here.
// This matters because the shipped `Slider` derives its thumb count from a `_values` that falls back
// to `[min, max]` whenever `value` is not an array: a scalar renders TWO thumbs at 0 and 100 while
// Base UI tracks one value. Measured on the registry file: 5 -> 2, undefined -> 2, [5] -> 1, [0] -> 1.
describe('WeightSliderField', () => {
  test('renders exactly one thumb for a stored weight', () => {
    render(<WeightSliderField value={5} onChange={rs.fn()} disabled={false} />);

    expect(screen.getAllByRole('slider', { hidden: true })).toHaveLength(1);
  });

  test('renders exactly one thumb for an absent weight', () => {
    render(<WeightSliderField value={undefined} onChange={rs.fn()} disabled={false} />);

    expect(screen.getAllByRole('slider', { hidden: true })).toHaveLength(1);
  });

  test('reports a bare number, never the array Base UI hands back', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={20} onChange={onChange} disabled={false} />);

    fireEvent.change(screen.getByRole('slider', { hidden: true }), { target: { value: '45' } });

    expect(onChange).toHaveBeenCalled();
    const reported = onChange.mock.calls[0]?.[0];
    expect(Array.isArray(reported)).toBe(false);
    expect(reported).toBe(45);
  });

  test('an out-of-range stored weight is shown as-is rather than snapped', () => {
    render(<WeightSliderField value={250} onChange={rs.fn()} disabled={false} />);

    expect(screen.getByTestId('weight-slider-value')).toHaveTextContent('250');
    const note = screen.getByTestId('weight-slider-out-of-range');
    expect(note).toHaveTextContent(/250/u);
    expect(note.textContent ?? '').not.toContain('{weight}');
  });

  test('an absent weight renders no numeric value and never writes zero on mount', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={undefined} onChange={onChange} disabled={false} />);

    expect(screen.queryByTestId('weight-slider-value')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

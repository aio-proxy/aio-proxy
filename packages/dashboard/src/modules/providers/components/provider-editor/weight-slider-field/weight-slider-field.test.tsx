import { m } from '@aio-proxy/i18n';
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
    render(<WeightSliderField value={5} onChange={rs.fn()} />);

    expect(screen.getAllByRole('slider', { hidden: true })).toHaveLength(1);
  });

  test('renders exactly one thumb for an absent weight', () => {
    render(<WeightSliderField value={undefined} onChange={rs.fn()} />);

    expect(screen.getAllByRole('slider', { hidden: true })).toHaveLength(1);
  });

  test('reports a bare number, never the array Base UI hands back', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={20} onChange={onChange} />);

    fireEvent.change(screen.getByRole('slider', { hidden: true }), { target: { value: '45' } });

    expect(onChange).toHaveBeenCalled();
    const reported = onChange.mock.calls[0]?.[0];
    expect(Array.isArray(reported)).toBe(false);
    expect(reported).toBe(45);
  });

  test('an out-of-range stored weight is shown as-is rather than snapped', () => {
    render(<WeightSliderField value={250} onChange={rs.fn()} />);

    expect(screen.getByRole('spinbutton')).toHaveValue(250);
    const note = screen.getByTestId('weight-slider-out-of-range');
    expect(note).toHaveTextContent(/250/u);
    expect(note.textContent ?? '').not.toContain('{weight}');
  });

  // The escape-hatch input accepts weights the slider's 0-100 track cannot express, which parked the
  // Base UI thumb past the end of the track for a stored 250. Only the *rendered* position is clamped:
  // the second half of this test is what rejects a later "simplification" that clamps the stored value
  // too and silently rewrites the user's 250 to 100.
  test('an out-of-range weight clamps the thumb to the track without touching the stored value', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={250} onChange={onChange} />);

    expect(screen.getByRole('slider', { hidden: true })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('spinbutton')).toHaveValue(250);
    expect(screen.getByTestId('weight-slider-out-of-range')).toHaveTextContent(/250/u);
    expect(onChange).not.toHaveBeenCalled();
  });

  // Finding 9: the slider is a one-way door. It clamps to 0-100 and snaps to step 5, so the first
  // touch destroyed a stored 250 or 7 with no way to type it back. The number input is bound to the
  // same form field; the mutant is routing it through the slider's min/max/step.
  test('the number input keeps a weight the slider cannot represent, neither clamped nor snapped', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={undefined} onChange={onChange} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '250' } });
    expect(onChange).toHaveBeenLastCalledWith(250);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  // "Absent stays absent" held only until the first drag: once a weight was set there was no
  // affordance to unset it. Empty means absent, and the mutant is `Number('') === 0`.
  test('clearing the number input reports absent rather than zero', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={40} onChange={onChange} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });

    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  // A deliberate 0 is a real weight and must not collapse into absent on the way in. Starts from 40
  // rather than absent: absent now *displays* 0, so a change event carrying '0' would match the value
  // already in the box and React would never call the handler — the assertion would pass against a
  // handler that was never invoked. The mutant is treating a falsy `Number(raw)` as empty.
  test('typing zero reports zero, not absent', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={40} onChange={onChange} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });

    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  // The number input is a second control in a field whose `<label>` pointed at nothing, so it would
  // have shipped unnamed. The mutant is dropping `htmlFor`, which leaves the input nameless while the
  // slider keeps its `aria-labelledby` and the field still looks labelled.
  test('the weight label names the number input', () => {
    render(<WeightSliderField value={40} onChange={rs.fn()} />);

    expect(screen.getByRole('spinbutton', { name: m['dashboard.providers.form.label_weight']() })).toBe(
      screen.getByTestId('weight-number-input'),
    );
  });

  // The display and the body disagree on purpose. An absent weight IS zero to the router, so the box
  // shows `0` beside a thumb already parked at zero; what must never happen is that rendering it
  // *writes* it. The `onChange` assertion is the whole point of this test — drop it and a `?? 1`
  // default silently stamps `weight: 1` into every provider the user merely opened.
  test('an absent weight displays one without writing one on mount', () => {
    const onChange = rs.fn();
    render(<WeightSliderField value={undefined} onChange={onChange} />);

    expect(screen.getByRole('spinbutton')).toHaveValue(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  // The meaning of the number shipped nowhere: no locale stated that a higher weight is attempted
  // first, so the slider was a bare 0-100 with no direction. This description is permanent; the
  // out-of-range one is a separate, conditional line that must survive alongside it. Asserting
  // `/\S/u` was the defect in this test: any non-empty string passed it, including a message whose
  // `{placeholder}` never interpolated.
  test('the higher-is-tried-first description is permanent, and the out-of-range one still renders', () => {
    const inRange = render(<WeightSliderField value={20} onChange={rs.fn()} />);

    const description = m['dashboard.providers.editor.weight_description']();
    expect(inRange.getByTestId('weight-slider-description')).toHaveTextContent(description);
    expect(description).not.toMatch(/[{}]/u);
    expect(inRange.queryByTestId('weight-slider-out-of-range')).toBeNull();
    inRange.unmount();

    const outOfRange = render(<WeightSliderField value={250} onChange={rs.fn()} />);

    expect(outOfRange.getByTestId('weight-slider-description')).toHaveTextContent(description);
    const note = outOfRange.getByTestId('weight-slider-out-of-range');
    expect(note).toHaveTextContent(/250/u);
    expect(note.textContent ?? '').not.toMatch(/[{}]/u);
  });
});
